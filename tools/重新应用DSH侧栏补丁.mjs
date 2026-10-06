#!/usr/bin/env node
/**
 * 重新应用 DSH 侧栏「套餐用量」补丁（sidebar + layout）。
 *
 * 背景：dsh-plan-usage 的侧栏胶囊依赖 DSH 核心包里的一个自定义席位
 * （sidebar.plan-usage）。DSH 本体升级会整包替换 node_modules，把该补丁冲掉，
 * 表现为「左侧不再显示额度」。本脚本按当前安装版本的源码结构重新打补丁，
 * 幂等：已打过的补丁会跳过。
 *
 * 用法：node 重新应用DSH侧栏补丁.mjs [--check]
 */
import { readFileSync, writeFileSync, existsSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const CHECK_ONLY = process.argv.includes("--check");

/** 依次尝试定位 DSH 全局安装目录。 */
function findDshRoot() {
  const candidates = [];
  const envHome = process.env.DSH_HOME;
  if (envHome) candidates.push(join(envHome, "..", ".."));
  try {
    const globalRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
    candidates.unshift(join(globalRoot, "@deepseek-ai", "dsh"));
  } catch {}
  candidates.push("C:\\Users\\Slacom\\AppData\\Roaming\\npm\\node_modules\\@deepseek-ai\\dsh");
  for (const c of candidates) {
    if (c && existsSync(join(c, "node_modules", "@deepseek-ai"))) return c;
  }
  throw new Error("找不到 DSH 安装目录，请手动指定");
}

const DSH = findDshRoot();
const SCOPE = join(DSH, "node_modules", "@deepseek-ai");
const SB = join(SCOPE, "dsh-client-ui-sidebar", "lib", "client.js");
const LAY = join(SCOPE, "dsh-client-ui-layout", "lib", "client.js");

const A1 = {
  name: "sidebar children 表（新增席位声明）",
  marker: '"sidebar.plan-usage"',
  old: '\t\t\t\t\t"sidebar.workspaces": {\n\t\t\t\t\t\tkind: "single",\n\t\t\t\t\t\tscope: "root"\n\t\t\t\t\t},\n\t\t\t\t\t"sidebar.settings": {',
  make: (o) => o.replace('"sidebar.settings": {', '// [local patch] plan-usage 用量角标席位\n\t\t\t\t\t"sidebar.plan-usage": {\n\t\t\t\t\t\tkind: "single",\n\t\t\t\t\t\tscope: "root"\n\t\t\t\t\t},\n\t\t\t\t\t"sidebar.settings": {'),
};

const A2 = {
  name: "sidebar footArea 渲染（插入 planUsageArea）",
  marker: 'renderSlot("sidebar.plan-usage", { wide })',
  old: 'children: [(0, react_jsx_runtime.jsx)("div", {\n\t\t\t\t\t\t\tclassName: SidebarRoot_module_css_default.footerActions,',
  make: (o) => o.replace(
    'children: [(0, react_jsx_runtime.jsx)("div", {\n\t\t\t\t\t\t\tclassName: SidebarRoot_module_css_default.footerActions,',
    'children: [(0, react_jsx_runtime.jsx)("div", {\n\t\t\t\t\t\t\tclassName: SidebarRoot_module_css_default.planUsageArea,\n\t\t\t\t\t\t\tchildren: renderSlot("sidebar.plan-usage", { wide })\n\t\t\t\t\t\t}), (0, react_jsx_runtime.jsx)("div", {\n\t\t\t\t\t\t\tclassName: SidebarRoot_module_css_default.footerActions,'),
};

const A3 = {
  name: "sidebar CSS（planUsageArea 布局规则）",
  marker: ".hHd-Xa_planUsageArea",
  old: ".hHd-Xa_settingsArea,.hHd-Xa_footerActions{flex:none;width:100%;min-width:0}.hHd-Xa_footerActions{display:flex}",
  make: (o) => o
    .replace(".hHd-Xa_settingsArea,.hHd-Xa_footerActions{flex:none", ".hHd-Xa_settingsArea,.hHd-Xa_footerActions,.hHd-Xa_planUsageArea{flex:none")
    .replace(".hHd-Xa_footerActions{display:flex}", ".hHd-Xa_footerActions{display:flex}.hHd-Xa_planUsageArea{margin-bottom:2px}")
    .replace(".hHd-Xa_collapsed .hHd-Xa_settingsArea,.hHd-Xa_collapsed .hHd-Xa_footerActions{", ".hHd-Xa_collapsed .hHd-Xa_settingsArea,.hHd-Xa_collapsed .hHd-Xa_footerActions,.hHd-Xa_collapsed .hHd-Xa_planUsageArea{"),
};

const A4 = {
  name: "sidebar CSS 模块映射",
  marker: '"planUsageArea": "hHd-Xa_planUsageArea"' ,
  old: '\t\t\t"footerActions": "hHd-Xa_footerActions",',
  make: (o) => o.replace('"footerActions": "hHd-Xa_footerActions",', '"footerActions": "hHd-Xa_footerActions",\n\t\t\t"planUsageArea": "hHd-Xa_planUsageArea",'),
};

const L1 = {
  name: "layout computeColumns（侧栏最小宽 219）",
  marker: "clampWidth(sidebar, 219, 420)",
  old: "const s = sidebar === 0 ? 56 : clampWidth(sidebar, 264, 420);",
  make: (o) => o.replace("clampWidth(sidebar, 264, 420)", "clampWidth(sidebar, 219, 420)"),
};

const L2 = {
  name: "layout setSidebar 拖拽 clamp（219）",
  marker: "clampWidth(px, 219, 420)",
  old: "clampWidth(px, 264, 420)",
  make: (o) => o.replace("clampWidth(px, 264, 420)", "clampWidth(px, 219, 420)"),
};

/** 对单个文件应用一组补丁。 */
function applyTo(file, patches, label) {
  if (!existsSync(file)) { console.log("  [" + label + "] 文件不存在，跳过：" + file); return { applied: [], failed: [] }; }
  let text = readFileSync(file, "utf8");
  const applied = []; const failed = [];
  for (const p of patches) {
    if (text.includes(p.marker)) { applied.push({ name: p.name, state: "已有" }); continue; }
    if (!text.includes(p.old)) { failed.push({ name: p.name, state: "锚点未找到（版本结构可能变化）" }); continue; }
    text = p.make(text);
    applied.push({ name: p.name, state: "新应用" });
  }
  const changed = applied.some((a) => a.state === "新应用");
  if (changed && !CHECK_ONLY) {
    const stamp = "bak-" + new Date().toISOString().slice(0, 10);
    if (!existsSync(file + "." + stamp)) copyFileSync(file, file + "." + stamp);
    writeFileSync(file, text);
    try { execFileSync(process.execPath, ["--check", file], { stdio: "pipe" }); }
    catch (e) { console.log("  !! 语法校验失败，请恢复 " + file + "." + stamp); throw e; }
  }
  for (const a of applied) console.log("  [" + label + "] " + a.state + "：" + a.name);
  for (const f of failed) console.log("  [" + label + "] !! " + f.state + "：" + f.name);
  return { applied, failed };
}

console.log("DSH 目录：" + DSH);
console.log(CHECK_ONLY ? "模式：仅检查" : "模式：应用");
console.log("");
const r1 = applyTo(SB, [A1, A2, A3, A4], "sidebar");
const r2 = applyTo(LAY, [L1, L2], "layout");
const failed = [...r1.failed, ...r2.failed];
console.log("");
if (failed.length) {
  console.log("有 " + failed.length + " 处补丁未能应用（结构变化，需要人工适配）。");
  process.exitCode = 1;
} else {
  console.log("全部补丁就绪。若刚应用过补丁，请重启 dsh web 并硬刷新浏览器。");
}