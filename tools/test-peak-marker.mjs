// 使用真实 client.js 的 PeakBar 样式和组件进行 Chromium 布局测试，无 npm 依赖。
// node tools/test-peak-marker.mjs [chrome.exe 路径]
import { readFileSync, writeFileSync, mkdirSync, openSync, closeSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
const code = source.slice(source.indexOf('var peakWrapStyle'), source.indexOf('// ===========================================================================\n// [0.8.1 回退记录]'))
assert(code.includes('function PeakBar'))
const dir = resolve('legacy/peak-marker-check')
mkdirSync(dir, { recursive: true })
const html = `<!doctype html><meta charset="utf-8"><style>
*{box-sizing:border-box}body{font:13px system-ui;background:#eef0f3;padding:20px;--dsw-alias-bg-base:#fff;--dsw-alias-label-tertiary:#6b7280;--dsw-alias-state-business-primary:#3d7ff5}section{background:#fff;padding:12px;margin:8px;width:max-content}p{margin:0}
</style><h1>真实 PeakBar 几何回归</h1><div id="cases"></div><pre id="result">RUNNING</pre><script>
var effects=[];var React={useRef:()=>({current:null}),useState:()=>[0,()=>{}],useEffect:fn=>effects.push(fn)};
function h(tag,props,...kids){var el=document.createElement(tag);props=props||{};for(var k in props){if(k==='style'){for(var s in props.style){var v=props.style[s];el.style[s]=typeof v==='number'&&!['zIndex','opacity','flexShrink','lineHeight'].includes(s)?v+'px':v}}else if(k==='ref'){props.ref.current=el}else{el.setAttribute(k,props[k])}}kids.flat(Infinity).forEach(x=>{if(x!=null)el.append(x instanceof Node?x:document.createTextNode(x))});return el}
${code}
var count=0,errors=[];
function check(cond,msg){count++;if(!cond)errors.push(msg)}
// 方案 K「上下对尖」：白柱移出轨道，上倒三角 + 下正三角夹住「现在」。
// 断言的是真实布局树几何：同轴、与轨道的 1px/2px 空隙、无轨道内覆盖物。
for(var zoom of [0.8,1,1.25,1.5])for(var width of [247,248,298,299,298.5,320.25]){
 var sec=document.createElement('section');sec.style.zoom=zoom;sec.append(h('p',{},width+'px / zoom '+zoom));
 var box=document.createElement('div');box.style.width=width+'px';sec.append(box);document.querySelector('#cases').append(sec);
 var now=Date.now();box.append(PeakBar({phase:{inPeak:true,nextAtMs:now+3600000},segs:[{s:now-12*3600000,e:now+12*3600000,t:'peak'}]}));
 var track=box.querySelector('[data-peak-track]').getBoundingClientRect(),caret=box.querySelector('[data-peak-caret]').getBoundingClientRect(),foot=box.querySelector('[data-peak-foot]').getBoundingClientRect();
 var center=r=>(r.left+r.right)/2;
 check(Math.abs(center(caret)-center(track))<0.04,'caret on axis '+width+'/'+zoom);
 check(Math.abs(center(foot)-center(track))<0.04,'foot on axis '+width+'/'+zoom);
 // 上三角：底缘在轨道上缘外 1px（top:-6 + height:5 → y=-1）。
 // zoom 会让 getBoundingClientRect 的坐标整体缩放，期望空隙按 zoom 放大。
 check(Math.abs(caret.bottom-(track.top-1*zoom))<0.04,'caret 1px gap above track '+width+'/'+zoom);
 // 下三角：顶缘在轨道下缘外 2px（top:10 → y=8+2）。
 check(Math.abs(foot.top-(track.bottom+2*zoom))<0.04,'foot 2px gap below track '+width+'/'+zoom);
 // 色条内部没有任何覆盖物：游标只由轨道外的两个三角构成，无 cursor/竖线元素。
 check(box.querySelector('[data-peak-cursor]')===null,'no in-track cursor '+width+'/'+zoom);
 check(box.querySelector('[data-peak-caret]').parentElement===box.querySelector('[data-peak-foot]').parentElement,'single anchor');
}
document.querySelector('#result').textContent=errors.length?'FAIL '+JSON.stringify(errors):'PASS '+count+' geometry assertions';
</script>`
const fixture = resolve(dir, 'fixture.html'), output = resolve(dir, 'dom.html')
writeFileSync(fixture, html)
const fd = openSync(output, 'w')
const chrome = process.argv[2] || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const child = spawnSync(chrome, ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--allow-file-access-from-files', '--user-data-dir='+resolve(dir,'browser-profile'), '--dump-dom', pathToFileURL(fixture).href], { stdio: ['ignore', fd, 'inherit'], timeout: 60000 })
closeSync(fd)
if(child.error)throw child.error
assert.equal(child.status,0,'Chromium exit')
const dom=readFileSync(output,'utf8')
const result=dom.match(/<pre id="result">([^<]*)<\/pre>/)?.[1]
assert(result?.startsWith('PASS '),result||'missing browser result')
console.log(result)
