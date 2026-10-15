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
// 奇偶、分数宽度，以及 CSS zoom，检验同一布局树中的实际几何，而非仅比较样式字符串。
for(var zoom of [0.8,1,1.25,1.5])for(var width of [247,248,298,299,298.5,320.25]){
 var sec=document.createElement('section');sec.style.zoom=zoom;sec.append(h('p',{},width+'px / zoom '+zoom));
 var box=document.createElement('div');box.style.width=width+'px';sec.append(box);document.querySelector('#cases').append(sec);
 var now=Date.now();box.append(PeakBar({phase:{inPeak:true,nextAtMs:now+3600000},segs:[{s:now-12*3600000,e:now+12*3600000,t:'peak'}]}));
 var track=box.querySelector('[data-peak-track]').getBoundingClientRect(),caret=box.querySelector('[data-peak-caret]').getBoundingClientRect(),cursor=box.querySelector('[data-peak-cursor]').getBoundingClientRect();
 var center=r=>(r.left+r.right)/2;
 check(Math.abs(center(caret)-center(cursor))<0.04,'caret/cursor '+width+'/'+zoom);
 check(Math.abs(center(cursor)-center(track))<0.04,'track center '+width+'/'+zoom);
 check(Math.abs(caret.bottom-track.top)<0.04,'caret must touch TOP '+width+'/'+zoom);
 check(Math.abs(cursor.top-track.top)<0.04&&Math.abs(cursor.bottom-track.bottom)<0.04,'cursor height '+width+'/'+zoom);
 check(box.querySelector('[data-peak-caret]').parentElement===box.querySelector('[data-peak-cursor]').parentElement,'single anchor');
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
