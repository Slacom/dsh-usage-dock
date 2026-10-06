# DeepSeek Harness (dsh) 移植 Termux 完整记录

> 日期：2026-08-14
> 设备：Xiaomi 25053RP5CC（小米），Android 16（SDK 36），aarch64
> 目标版本：`@deepseek-ai/dsh@0.1.0-rc.6`（GitHub: deepseek-ai/deepseek-harness，MIT）
> 最终结果：✅ 在 Termux 上运行 Web UI，浏览器访问 `http://127.0.0.1:3080`，形似 code-server

---

## 一、结论先行

**可以实现，但这是"移植"而不是"安装"。** dsh 是面向桌面操作系统的 agent harness：工具链包含 PowerShell 执行器、Windows 路径与沙箱、原生模块（koffi / node-pty / sharp），代码里**没有任何 Android 分支**。在 Termux 上跑通需要 **11 处手术**，其中 4 处是 Android 系统级限制（hard link 被禁）的绕过。

**与 code-server 的本质区别**：code-server 就是为服务器设计的远程 IDE；dsh 的 agent 直接运行在工作区所在机器上（bash / fs / tmux 工具在本地执行），Web UI 只是前端。手机上的 Termux 恰好提供了完整的 Linux 运行环境，所以核心链路可行。

---

## 二、环境准备

```bash
# Termux 里安装基础环境
pkg install nodejs           # 实测装到 v26.4.0（要求 ^22.19.0 || >=24.0.0）
pkg install cmake make clang ninja python pkg-config   # 编译工具链（原生模块需要）
```

检查 Node 版本（硬性要求）：

```bash
node -v    # 必须 >= 22.19 或 >= 24，否则 dsh 拒绝启动
```

---

## 三、安装命令（标准流程）

```bash
# 全局安装 dsh（必须 --ignore-scripts，否则原生模块编译失败会回滚整个安装）
# 必须走 npmmirror 镜像（官方 registry 在国内极慢，曾卡 20 分钟无进展）
npm i -g @deepseek-ai/dsh@0.1.0-rc.6 --ignore-scripts --registry=https://registry.npmmirror.com

# 补齐 Android 缺失的原生模块支持（见手术 3/4/5）
cd /data/data/com.termux/files/usr/lib/node_modules/@deepseek-ai/dsh
npm install @img/sharp-wasm32 --registry=https://registry.npmmirror.com --ignore-scripts
```

---

## 四、十一处手术详细记录

### 手术 1：npm 源慢 + 安装回滚

**现象**：`npx @deepseek-ai/dsh web` 或 `npm i -g` 直接卡死（spinner 转 20 分钟缓存不涨）；koffi 编译失败时 npm 会**回滚整个安装**，node_modules 全部清理。

**根因**：官方 registry.npmjs.org 国内直连极慢；`@deepseek-ai/dsh` 依赖链里有 `koffi`（原生 FFI）等 install 脚本，失败即整体失败。

**修复**：`--registry=https://registry.npmmirror.com`（实测 0.2s 响应）；`--ignore-scripts` 跳过所有 install 脚本。

---

### 手术 2：koffi 编译失败（statx 错误）

**现象**：CMake 已找到，ninja 编译报错：

```
error: cannot initialize a member subobject of type '__u32' (aka 'unsigned int') with an lvalue of type 'const char *'
2967 |     if (statx(fd, pathname, stat_flags, stat_mask, &sxb) < 0) {
```

**根因**：bionic（Android libc）中 API level < 30 时**不声明 `statx()` 函数**，但 `<linux/stat.h>` 定义了 `struct statx` 类型 → C++ 把 `statx(...)` 解析成对结构体的函数式转换，编译失败。

**修复**：patch `node_modules/koffi/lib/native/base/base.cc`：

```diff
- if (statx(fd, pathname, stat_flags, stat_mask, &sxb) < 0) {
+ if (syscall(__NR_statx, fd, pathname, stat_flags, stat_mask, &sxb) < 0) {
```

然后手动编译（koffi 无 Android 预编译，必须源码构建）：

```bash
cd /data/data/com.termux/files/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/koffi
node ./cnoke.cjs -P . -D src/koffi --prebuild --release
# 成功标志：[4/4] Linking CXX shared library Output/koffi.node
```

---

### 手术 3：node-pty 编译（headers 下载失败）

**现象**：node-gyp 编译 node-pty 时 `gyp ERR! ... TLSWrap.onStreamRead`——下载 node headers 时 TLS 连接失败（nodejs.org 直连不通）。

**修复**：从 npmmirror 下载 headers 并用 `--nodedir` 指定：

```bash
curl -L -o ~/node-headers.tar.gz https://cdn.npmmirror.com/binaries/node/v26.4.0/node-v26.4.0-headers.tar.gz
mkdir -p ~/node-headers && tar -xzf ~/node-headers.tar.gz -C ~/node-headers

cd /data/data/com.termux/files/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/node-pty
node /data/data/com.termux/files/usr/lib/node_modules/npm/node_modules/node-gyp/bin/node-gyp.js \
  rebuild --nodedir=/data/data/com.termux/files/home/node-headers/node-v26.4.0
# 成功标志：gyp info ok，生成 build/Release/pty.node
```

> 注意：node-gyp 不在 PATH（是 npm 的内置依赖），要用完整路径调用。

---

### 手术 4：sharp 加载失败（boot 崩溃）

**现象**：`dsh web` 启动即崩溃：

```
Error: dsh: plugin tree failed to load: ... Could not load the "sharp" module using the android-arm64 runtime
```

**根因**：`dsh-attachment-local` 插件**顶层静态 import** sharp，而 sharp 没有 android-arm64 预编译二进制，找不到就整体 boot 失败。

**修复**：安装 WASM 运行时（版本必须与 sharp 严格一致 0.35.3）：

```bash
cd /data/data/com.termux/files/usr/lib/node_modules/@deepseek-ai/dsh
npm install @img/sharp-wasm32 --registry=https://registry.npmmirror.com --ignore-scripts
```

---

### 手术 5：沙箱 fails closed（最大的坑）

**现象**：`dsh web` 启动报 2 个 pending：

```
@deepseek-ai/dsh-bash-sandbox: pending (waiting for services: sandbox, sandboxPolicy)
@deepseek-ai/dsh-permission-presets: pending (waiting for service: shell)
```

**根因**：`dsh-sandbox-local` 的平台链只有 `linux: [bwrap, landlock] / darwin: [seatbelt] / win32: [windows-acl]`，**没有 android** → 空链 fails closed（源码注释明示）。而 `bash-sandbox` 是**硬依赖** `sandbox` + `sandboxPolicy` 服务（网上流传的"禁用后回退 LocalBashExecutor"说法在 rc.6 实测**是错的**），禁掉底层沙箱导致 bash-sandbox 不激活 → 不提供 shell 服务 → permission-presets 连锁 pending。

**修复**：利用 sandbox 插件官方支持的 `runnerCommand` 配置（operator's assertion，绕过平台链探测），注入一个**直通 wrapper**。

写 `~/sandbox-passthrough.sh`：

```bash
#!/data/data/com.termux/files/usr/bin/bash
# dsh sandbox passthrough wrapper: 跳过 bwrap 风格的参数，直接执行 "--" 之后的命令
args=("$@")
for i in "${!args[@]}"; do
  if [ "${args[$i]}" = "--" ]; then
    exec "${args[@]:$((i+1))}"
  fi
done
exec "$@"
```

写 `~/no-sandbox.yml`（patch 覆盖层）：

```yaml
- id: sandbox
  config:
    runnerCommand:
      - /data/data/com.termux/files/home/sandbox-passthrough.sh
    runnerFailureSignatures:
      - "SANDBOX_UNAVAILABLE"
```

> 副作用：所有 bash/fs 命令无沙箱隔离，直接透传执行（本机自用可接受）。

---

### 手术 6：HMR 需要 --expose-internals

**现象**：boot 到最后一步报错 `@deepseek-ai/cordis-plugin-hmr: --expose-internals is required for HMR service`。

**修复**：启动命令必须带 Node 标志：

```bash
node --expose-internals $(which dsh) --profile web --patch ~/no-sandbox.yml
```

---

### 手术 7：shebang 问题（/usr/bin/env 不存在）

**现象**：直接执行 `dsh` 报 `bash: /usr/bin/dsh: /usr/bin/env: bad interpreter: No such file or directory`。

**根因**：dsh 的 shebang 是 `#!/usr/bin/env node`，Termux 没有 `/usr/bin/env`（除非 proot）。

**修复**：用 `node $(which dsh)` 直接调用，绕开 shebang。

---

### 手术 8：会话写入 link 失败（Android 禁 hard link）

**现象**：浏览器里发消息报错：

```
EACCES: permission denied, link '.../session.jsonl.zstd.d4444f9eb1fc.tmp' -> '.../session.jsonl.zstd'
```

**根因**：**Android 15 的 SELinux 对 app 全域禁 hard link**（实测 Termux 的 home / $PREFIX / /sdcard 任何路径 `ln` 都 Permission denied）。dsh 的会话持久化用 `link()` 做原子发布（写临时文件 → 硬链接到最终名）。

**修复**：patch `dsh-session-persistence-jsonl/lib/index.js`，`link` 改 `rename`（rename 实测可用，且代码里有前置存在性检查，语义等价）：

```diff
- import { link, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, stat, truncate } from "node:fs/promises";
+ import { mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, stat, truncate } from "node:fs/promises";

- await link(tmp, finalPath);
+ await rename(tmp, finalPath);
```

---

### 手术 9：Write 工具（写文件）link 失败

**现象**：agent 用 Write 工具创建工作区文件报错：

```
EACCES: permission denied, link '.../.test.txt.19451.xxx.tmpdir/test.txt.tmp' -> '.../test.txt'
```

**根因**：`dsh-fs-local` 的 `writeFileAtomic()` 在 `createIfAbsent` 模式下用 `link()` 发布（no-replace 语义），Android 上必炸。

**修复**：patch `dsh-fs-local/lib/index.js`，`linkFile` 改为智能回退——link 失败且 EACCES/EPERM 时：目标已存在 → 抛原错保持"拒绝覆盖"语义；目标不存在 → 改用 rename：

```js
const linkFile = internals.linkFile ?? (async (srcPath, dstPath) => {
    try {
        await link(srcPath, dstPath);
    } catch (linkError) {
        if (linkError.code === "EACCES" || linkError.code === "EPERM") {
            try {
                await lstat(dstPath);
                throw linkError;
            } catch (statError) {
                if (statError.code === "ENOENT") {
                    await rename(srcPath, dstPath);
                    return;
                }
                throw statError;
            }
        }
        throw linkError;
    }
});
```

---

### 手术 10：Glob 工具 ripgrep 启动失败

**现象**：Glob 工具报 `Error: glob could not start its search command (ripgrep launch failed)`，agent 只能回退 bash `ls`。

**根因**：glob 用 `@vscode/ripgrep` 的**打包二进制**，该包只有 darwin/win32/linux 平台子包，**Android 没有** → import 失败。

**修复**：patch `dsh-tool-fs-search/lib/index.js` 的 `resolveRgPath()`，平台包缺失时 fallback 到系统 rg：

```js
function resolveRgPath() {
    rgPathPromise ??= import("@vscode/ripgrep").then((module) => module.rgPath).catch(async () => {
        const { spawnSync } = await import("node:child_process");
        const probe = spawnSync("which", ["rg"], { encoding: "utf8" });
        if (probe.status === 0 && probe.stdout.trim().length > 0) return probe.stdout.trim();
        throw new Error("neither @vscode/ripgrep nor system rg is available");
    });
    return rgPathPromise;
}
```

---

### 手术 11：浏览器加载问题（非代码问题）

**现象**：系统自带浏览器（com.android.browser）打开 `http://127.0.0.1:3080` 一直转圈加载不完。

**根因**：dsh 前端是重型 SPA（要加载 30+ 个插件 client.js），系统浏览器内核太旧撑不住。**服务本身完全正常**（内置浏览器验证渲染完整、curl 200 + 12KB HTML、WebSocket `/api/events.mux` 与 `/api/events.host` 均握手成功）。

**修复**：改用 Chrome 打开。

> 另一个嫌疑：手机上的 VPN / 加速器（如"一元加速"）会劫持流量，可能拦截 localhost 请求，测试前建议关闭。

---

## 五、工具链验证结果

headless 模式实测（`dsh --profile headless`）：

| 工具 | 测试内容 | 结果 |
|---|---|---|
| bash/shell | echo、pwd、whoami、find、du | ✅ 沙箱直通生效 |
| fs 写（Write） | 创建文件并读回 | ✅ 手术 9 后正常，真实落盘 |
| fs 读/列（Read/List） | 读文件、列目录 | ✅ |
| Glob 搜索 | 搜 *.py | ✅ 手术 10 后正常 |
| Web 抓取 | 抓取 example.com | ✅ |
| LLM 推理 | 多工具组合任务 | ✅ |
| 自动回退 | 工具报错时 | ✅ agent 自动换 bash 兜底 |

---

## 六、使用指南

### 启动 Web UI

```bash
node --expose-internals $(which dsh) --profile web --patch ~/no-sandbox.yml
```

看到 `dsh web: http://127.0.0.1:3080` 后用 **Chrome** 访问。

后台运行（输出到日志）：

```bash
nohup node --expose-internals $(which dsh) --profile web --patch ~/no-sandbox.yml > ~/dsh-web.log 2>&1 &
```

### 配置与使用

1. 浏览器打开 `http://127.0.0.1:3080`
2. 点"继续"跳过内测声明
3. **设置 → Models**：填 DeepSeek API key（存于 `~/.dsh/.credentials.yaml`）
4. **选择工作区**：选 Termux 里的项目目录（如 `~/downloads`）
5. 新建会话，直接描述任务即可（agent 会自动调用 bash / 文件 / 网络工具）

### headless 模式（命令行测试）

```bash
node --expose-internals $(which dsh) --profile headless --patch ~/no-sandbox.yml "运行 echo hello 并告诉我结果"
```

### 一键测试工具链

```bash
# bash
... --profile headless --patch ~/no-sandbox.yml "运行 uname -a 和 whoami 告诉我结果"
# 文件
... --profile headless --patch ~/no-sandbox.yml "创建 test.txt 写入 hello 再读出来"
# 网络
... --profile headless --patch ~/no-sandbox.yml "抓取 example.com 的标题"
```

---

## 七、维护注意事项

1. **固定版本**：`npm update` 会重踩 koffi 编译和**所有 node_modules 补丁**（手术 2/3/4/8/9/10 全在 node_modules 里）。务必固定 `@deepseek-ai/dsh@0.1.0-rc.6`。
2. **无沙箱隔离**：bash/fs 命令直接透传执行（手术 5 的代价），不要在不信任的工作区上运行。
3. **pwsh / Windows 功能不可用**：PowerShell 执行器、Windows ACL 沙箱在 Android 上不存在，但都是惰性加载（调用才失败），不影响核心。
4. **HMR 标志**：启动必须带 `--expose-internals`，否则 boot 失败。
5. **补丁文件清单**：
   - `~/no-sandbox.yml` — 沙箱直通 patch 层
   - `~/sandbox-passthrough.sh` — 直通 wrapper 脚本
   - `~/node-headers/` — node-gyp 编译用 headers（保留，重装 node-pty 要用）
6. **相关日志**：`~/dsh-web.log`（Web UI 运行日志）、`~/dsh-install*.log`（安装日志）。

---

## 八、相关文件位置

| 文件 | 用途 |
|---|---|
| `~/.dsh/profiles/web/` | web profile 配置（`cordis.yml` / `cordis.patch.yml`） |
| `~/.dsh/.credentials.yaml` | 模型 API key |
| `~/.dsh/sessions/` | 会话持久化（zstd 压缩 JSONL） |
| `~/.dsh/storages/` | 工作区等状态 |

---

*文档由 Qi Agent 于 2026-08-14 整理。所有手术步骤均已在设备上实测验证。*
