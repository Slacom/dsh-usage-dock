# MiMo 正式扫码主线 · 直接覆盖安装（2026-11-06）

## 当前结论

用户明确要求直接覆盖、不再准备回退。**最新：2026-11-07 本人已观察真实扫码、身份核对、接入、余额读取、胶囊/详情显示、收起界面仍定时刷新，以及本地授权上限触发后停止与移除旧值。** 最后截图状态为 `E_MIMO_AUTH_DISPLAY_REFRESH_EXHAUSTED`，不代表小米票真实过期，也不单独证明内存擦除或15分钟独立计时路径。短时闭环可收口；真实401续期、长时运行或跨重启仍未验，延长持有窗口需新的具体授权。下方初次安装时间和写入数量是2026-11-06初次覆盖的历史记录；代理从未自行登录、读取真实账号／余额或重启。

- 安装结束：2026-11-06 16:24:26 +08:00。
- 目标：[desktop 已装插件](<C:/Users/Slacom/.dsh/profiles/desktop/node_modules/dsh-usage-dock/>)。
- [安装清单](<../.diagnostics/mimo-console-install-20261106/INSTALL-MANIFEST.json>) 为 `status=complete`、`deployed=true`、`consoleProtocolEnabled=true`。
- 14 文件依赖闭包全部核对匹配；**实际写入9个：覆盖6个、新增3个；其余5个哈希不变、未写入**。
- 未新建备份或回退脚本，未删除旧备份；未修改配置、凭据、普通余额 provider、其它渠道或版本元数据。安装版本标记仍是 0.9.0。
- 已做覆盖前 JavaScript 语法与相对依赖闭包检查、覆盖后14文件逐项核对；没有重新跑旧矩阵。
- 没有由代理发起真实登录、二维码、账号或余额请求；没有访问GUI、重启、提交、推送或发布。

## 基线与安装差异

现场核对：入口与客户端是官方0.9.0原文件；9份旧认证辅助文件仍在且匹配此前stage。最初目录搜索漏报了这些文件，已以逐文件哈希结果纠正，不推断基线变化原因。

- 入口复用已审的仅注册MiMo版本，并验证移除三行注册代码后与当前官方入口逐字相等；没有使用含无关改动的工作区入口。
- 客户端只合入10个MiMo hunk，排除5个WorkBuddy/账号接口 hunk；没有整份复制工作区客户端。
- 带入完整认证模块闭包，保持旧session/dynamic-policy/vendor等5份不变文件不重写。
- 安装副本的[Host 注册点](<C:/Users/Slacom/.dsh/profiles/desktop/node_modules/dsh-usage-dock/plans/mimo-auth/host.js#L51>) 显式传入已离线验证的代码级开关：

```js
child = createAuthHost(c, bootEpoch, onStatus, { enableConsoleProtocol: true })
```

工作区的[Host 源码](<../plans/mimo-auth/host.js>)默认仍关闭；这次启用只作用于本地安装副本，不引入UI/JSON开关。之前[独立终审](<mimo-console-mainline-review-20261106.md>)判定的是安装前本地源码范围，不能把它扩大为真实协议成功。

## 本人真实试用反馈与最小修正

- 首次：用户确认真实二维码可见、手机能确认；点击手机确认后插件报 `E_MIMO_CONSOLE_AUTH_REQUIRED`。没有读取/保存上游真实响应，不推断手机成功等于已获得平台票。
- 发现代码仅收字符串账号 ID 的兼容缺陷。正确 numeric 成功例在修正前得到28/1；修正后协议34/0、e2e56/0。只对词法纯正整数且安全可精确表示的数值 ID 规范化，actual／平台／事前 expected 比较不变；补4类固定原因码。Max 对3文件差异 Pass，已精准覆盖3文件。
- 第二次：用户报告手机显示登录成功，但插件报 `E_MIMO_CONSOLE_UNSUPPORTED`。说明实际登录链仍未成功；**不以错误码变化证明数值兼容就是首次真实故障根因**。
- 对第二次不作猜测性业务放宽：将原 unsupported 分支细分为预定义、无数据的原因码（JSON、LP Cookie 域／其它策略、种子冲突、challenge、未知后续目标、SSO拒绝、平台 Cookie 等）。不输出／保存 Cookie 名值、账号、真实字段、URL、回包或原始异常；不增加目标或请求，不放宽域／身份／用途限制。
- 离线协议38/0、e2e57/0；新增负例证明 LP 父域 Cookie、非法字节、challenge、未知跳转、平台父域 Cookie 在原位置仍被拒绝且不发下游请求。Max静态差异确认无阻断；**2文件诊断补丁已覆盖，14文件闭包核对一致**，保留enabledHost，未重启／请求／新建备份。此补丁仅为下一次定位，不称真实问题已修复，等待本人重启后仅一次定位测试。清单见[固定原因码补丁记录](../.diagnostics/mimo-console-install-20261106/PATCH-FIXED-REASONS-MANIFEST.json)。

### 第三次：LP Cookie 域拒绝的候选修正

- 用户报告固定码 `E_MIMO_CONSOLE_LP_COOKIE_DOMAIN`：已确认失败在扫码响应 Cookie 解析的域拒绝分支，未进入余额；具体是哪条 Cookie／哪个域仍未读取，不作猜测性事实记录。
- 修正仅在协议账号响应入口：每行先用隔离临时 Jar 按真实 account／已批准子域来源验证；只保留原有4个账号凭据名。合法的 `Domain=xiaomi.com` 单向收窄为 `account.xiaomi.com`；不改 host-only、不扩大源域，不改 Path/Secure/HttpOnly/Max-Age/Expires。账号长期 Jar 仍是原窄 root；平台规则、授权用途与网络目标未改。
- 合法但无关的登录 Cookie 验证后不入凭据 Jar；外域／公共后缀／兄弟域／重复 Domain 仍拒。所有路径的同名值和 JSON seed 冲突均拒；显式删除／过期不被 JSON 复活，已给出的属性不被合成 session cookie 覆盖。
- 父域成功用例在修前得到37/1、同域错误码；修后协议43/0、e2e57/0，e2e 同时包含数值ID与父域Cookie。补充 `/pass` 路径冲突后两套再次43/0、57/0。全部离线 fake DNS/HTTPS；不称已复现具体真实回包。Max最小差异及路径冲突加强静态确认均无阻断。
- **已只覆盖协议1文件，完整14文件闭包核对一致**，保留正式入口、不建回退、不重启或请求；等待本人重启后再试。见[账号 Cookie 补丁清单](../.diagnostics/mimo-console-install-20261106/PATCH-ACCOUNT-COOKIE-SCOPE-MANIFEST.json)。这是针对已知分支的候选修复，尚未证明真实登录成功。

### 第四次：LP Cookie POLICY 与无关项隔离

- 用户报 `E_MIMO_CONSOLE_LP_COOKIE_POLICY`；仍只有类别、实际行未读取，不将真实故障归因于某个凭据／属性。
- 本地正确排除用例在旧实现42/1：非凭据Cookie含空格／引号也会因先probe而阻断。修正为先按首pair精确匹配原4名，非凭据整行不解析、不入Jar、不发送；4个必要名仍完整验证，外域、非法值、重复Domain／不同同名值、删除／过期、Path限制仍生效。
- 剩余必要凭据拒绝细分LP／ACCOUNT固定枚举：CRLF、大小、名称、值格式、过期属性格式、重复Domain、重复值、数量上限、解析异常等。不留账号／Cookie名值／URL／回包，不把任意错误拼为code。
- 修后协议45/0、e2e58/0；包含8类必要项拒绝的精确code与4hop／callback0、SSO必要项非法3hop即停、无关项不出站、完整数值ID＋父域Cookie＋无关项wire。Max仅2文件静态确认无阻断。
- **已覆盖协议与client白名单2文件，14/14闭包核对一致**；不动已启用Host、不新建回退，不由代理重启或请求。此为候选修正与完整定位码，不称真实已修好；等待本人测试。见[凭据限定入口补丁记录](../.diagnostics/mimo-console-install-20261106/PATCH-CREDENTIAL-ONLY-INTAKE-MANIFEST.json)。

### 第五次：平台响应 Cookie 域拒绝

- 用户本人截图报 `E_MIMO_CONSOLE_PLATFORM_COOKIE_DOMAIN`，不是 LP 前缀；失败在平台响应Cookie接收，未证明平台会话／余额成功。实际Cookie域和值仍未知，未读取或存储。
- 原账号接收算法改为按固定class共享的 `scopeCredentialResponseCookies`。平台来源仅HTTPS精确 `platform.xiaomimimo.com`、不允许子域；只留A1已有4名（serviceToken/slh/ph的api-platform前缀名与userId），合法父域 `xiaomimimo.com` 只收窄为platform主机；永久Jar仍原窄root。无关项不入Jar／不发出，必要项域／字节／TTL／Path／冲突／撤销仍完整检查。
- 首次callback、fresh SSO callback、余额200续发、401/403删除均统一该入口；fresh票未通过即finally清，成功移交后显式清旧Jar。不新增目标、用途、权限或时间上限。平台拒绝补齐同13个固定原因码，UI仅添加白名单。
- 正确平台父域例修前44/1，修后协议49/0、e2e59/0。断言包括首次5hop/balance0、401换票精确+5、只发送4平台名、外域／公共后缀／账号域／兄弟域拒、非法／重复／删除／变号拒、余额续发下一请求实用新票且Path受限。e2e同时包含数字ID、账号父域、平台父域及无关格式Cookie，全为假DNS/HTTPS。
- Max仅2文件差异静态确认无阻断，核过全部平台写入口。**2文件已覆盖，14/14安装闭包匹配，Host启用未变，无新备份／代理重启／请求。**等本人重启后测试；不声称实际域已知或真实已修好。见[平台接收补丁清单](../.diagnostics/mimo-console-install-20261106/PATCH-PLATFORM-COOKIE-INTAKE-MANIFEST.json)。

### 第六次：必要平台值格式与显式引号兼容例外

- 用户截图 `E_MIMO_CONSOLE_PLATFORM_COOKIE_VALUE_FORMAT`。未读取真实值，因此只确认格式拒绝分支，不声称真实值一定带引号。
- [RFC6265 §4.1.1](https://www.rfc-editor.org/rfc/rfc6265.html#section-4.1.1)允许双引号包裹cookie-octet值。不能据此擅自去引号发出：本补丁保留Jar原始值和出站header，引号与+/=均不重写；仅身份／seed／冲突的语义比较读取外引号内的内容。
- 主说明此前vendor只读边界并请求最小例外；用户要求通俗解释后明确允许。只在 `vendor/cookie-jar.js` 加默认关闭、严格true启用的选项，console7个Jar显式启用，legacy无opt-in；原大小／CRLF／域／Path／过期规则不变。`console-grants.js`匹配合法完整引号及非空内部octet，仍拒空格、CTL、逗号、分号、反斜杠、内部引号和损坏格式。不改其它vendor或旧flow/session。
- 正确quoted平台原值保留例修前49/1；修后新quote套8/0、受影响grants18/0、protocol52/0、e2e59/0。验证旧默认/false/string true仍拒quote、启用后原值发送、Path/TTL/删除/域不变、恶意quote仍拒、quoted UID变号仍拒，端到端含双引号token与UID。Max只读最小3源差异确认无阻断，未重跑套。
- **Jar、grants、protocol共3文件已精准覆盖，含vendor的14/14闭包核对一致**；Host启用保留、无备份/代理重启/请求；等本人重启测试，未证明真实根因或真实成功。见[引号兼容补丁清单](../.diagnostics/mimo-console-install-20261106/PATCH-QUOTED-COOKIE-MANIFEST.json)。

### 2026-11-07：真实认证首次成功，首读余额类型兼容

- 用户本人GUI截图先出现“已确认，待接入显示”，已扫码确认且身份核对；这是**真实认证阶段成功**证据，不等于余额／自动刷新／真实401续期已通过。随后点击接入与“读取一次余额”，截图报 `E_BALANCE_PARSE` 并停止，不显示未经确认的值。未读取真实回包、账号ID或金额。
- 只读既有[MiMo接口说明](../plans/mimo.js#L4-L9)明确金额字段是字符串；新协议将vendor data直交number-only显示投影，遗漏入口转换。按既有形状补正确用例，修前52/1、同余额解析错误；不将合成失败称真实回包复现。
- 仅协议增加私有wallet入口：原四字段白名单，金额仅接受number或长度≤64的规范非负十进制字符串，再经原共享投影的finite／非负／真实币种检查。不补币种、不补零、不从cash或total替代主余额，不读套餐/usage；共享显示契约不改。登录、Cookie、用途、SSO、预算不变。
- 修后协议56/0、真实Host→客户端mock→协议/传输e2e59/0（全离线）。端到端wire已改成字符串金额；覆盖首读单请求、零有效、缺明细、非法类型／格式仍拒、缺币种不补、401后字符串金额仍精确5跳。Max仅新helper和1行接线静态无阻断，未跑旧矩阵。
- **已只覆盖协议1文件，重建校验移除helper和替换1行后与上次已装内容逐字一致；14/14闭包匹配**，保留已批准引号兼容与启用Host。未新建备份、未代理重启／真实请求。见[余额字符串补丁清单](../.diagnostics/mimo-console-install-20261106/PATCH-DECIMAL-WALLET-MANIFEST.json)。等待本人重启后扫码、接入、再读一次余额；尚未证明实际失败唯一原因或真实余额成功。

### 2026-11-07 14:16：本人确认真实余额正常显示

- 用户明确报告“这次可以正常显示了”，截图为显示中，有取数时间，正常侧栏已有MiMo金额。至此真实认证／身份核对／接入／单次读取／侧栏显示成功，非仅离线测试；不落实际金额或账号尾号。
- 用户另表示已点击“授权持续刷新”。截图仍0/14、授权按钮尚在，可能是点击前截图；不把点击声明等同于Host授权响应或首轮自动刷新已经成功。保持应用运行，观察至少一两轮的取数时间更新及计数增长，不要求重新扫码／重启／改代码。
- 15分钟/60秒/14次仍为临时本地边界。实际401续期、长期运行、跨重启仍未验；无新安装写入，无代理真实请求。之前“真实余额尚未通过”的段落保留为历史时点。

## 用户真实测试

1. 完全退出再打开DSH；必要时刷新设置页。仅刷新网页不能代替Host重启。
2. 在 Usage Dock 的 MiMo 设置中使用正式本机显示会话面板，不使用旧实验性临时扫码入口。
3. 输入自己事前知道的小米账号ID（不是Cookie/API Key），点击“创建并开始扫码登录”，用本人手机扫码。如果ID不确定，不猜、不发送Cookie给代理。
4. 如出现区域登录目标审批，核对账号域提示后再明确批准；不认可则取消。
5. 身份核对通过后点击“确认身份并接入显示（尚不读余额）”，再点击“读取一次余额（只读，不兑换）”。
6. 仅在与本人控制台余额一致时确认，再按需“授权持续刷新”。观察正常胶囊/详情；不一致、失败或不想继续时停止。

本轮测试仍受120秒登录期限、15分钟内存持有、60秒刷新间隔与最多14次自动刷新等临时本地界约束；不证明厂商有效期或长期续期成功。遇到错误先报告阶段与固定错误码，不上传二维码、Cookie、账号ID或上游原始响应。
