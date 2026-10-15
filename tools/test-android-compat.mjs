// DSHA 类宿主的离线契约检查；不冒充 Android 真机测试。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { apply, inject } from '../index.js'
import { PLANS } from '../plans/index.js'
let passed = 0
function check(name, fn) { fn(); passed++; console.log('[PASS] '+name) }
const disabled = Object.fromEntries(PLANS.map(p => [p.fields.enabled, false]))
function handlerFor(config, get = () => undefined) {
  let handler
  apply({ get, webServer: { port: 12345, register(spec) { handler=spec.handler; return ()=>{} } }, effect: fn=>fn() }, config)
  return handler
}
async function request(handler, method='GET') {
  let status, body
  await handler({method}, {writeHead(s) {status=s}, end(text) {body=JSON.parse(text)}})
  return {status,body}
}
check('Host 只强制依赖 webServer',()=>assert.deepEqual(inject,['webServer']))
const originalFetch=globalThis.fetch
try {
  globalThis.fetch=async()=>({status:200,text:async()=>JSON.stringify({is_available:true,balance_infos:[{currency:'CNY',total_balance:'11.38'}]})})
  const handler=handlerFor({...disabled,deepseekEnabled:true,deepseekApiKey:'test-key'})
  const response=await request(handler)
  check('真实 Host 路由无 shell/账号/configEditor 仍取 API 余额',()=>{
    assert.equal(response.status,200);assert.equal(response.body.data.plans[0].balance,11.38);assert.equal(response.body.data.plans[0].via,'api')
  })
  const nullAccount=handlerFor({...disabled,deepseekEnabled:true,deepseekApiKey:'test-key'},()=>null)
  const nullResult=await request(nullAccount)
  check('null 服务不阻断真实路由',()=>assert.equal(nullResult.body.data.plans[0].balance,11.38))
  for (const mode of ['sync','async']) {
    const first=PLANS[0],second=PLANS[1],originalA=first.fetch,originalB=second.fetch
    try {
      first.fetch=mode==='sync'?()=>{throw new Error('provider failure')}:async()=>{throw new Error('provider failure')}
      second.fetch=async()=>({id:second.id,name:second.name,isAvailable:true})
      const out=await request(handlerFor({...disabled,[first.fields.enabled]:true,[second.fields.enabled]:true},name=>{if(name==='shell')throw new Error('missing optional service')}))
      check('单渠道 '+mode+' 异常隔离，不拖垮其他渠道',()=>{
        assert.equal(out.status,200);assert.equal(out.body.data.plans[0].error,'exec');assert.equal(out.body.data.plans[1].isAvailable,true)
      })
    } finally {first.fetch=originalA;second.fetch=originalB}
  }
  // 这里改 mock：模拟安卓端未安装可选的 WorkBuddy 插件。
  globalThis.fetch=async()=>({status:404,json:async()=>({})})
  const missing=await request(handlerFor({...disabled,workbuddyEnabled:true}))
  check('未安装 WorkBuddy 仅返回本渠道 not-installed',()=>assert.equal(missing.body.data.plans[0].error,'not-installed'))
  const post=await request(handler,'POST')
  check('方法限制仍为405',()=>assert.equal(post.status,405))
} finally {globalThis.fetch=originalFetch}

// 提取实际 PeakBar，严格校验不同数据状态下 hooks 数量与 effect 清理。
const source=readFileSync(new URL('../client.js',import.meta.url),'utf8')
const code=source.slice(source.indexOf('var peakWrapStyle'),source.indexOf('// ===========================================================================\n// [0.8.1 回退记录]'))
const originalWindow=globalThis.window, originalSetInterval=globalThis.setInterval, originalClearInterval=globalThis.clearInterval
const slots=[],timers=new Map();let cursor=0,queue=[],dirty=false,hookCount
const slot=()=>{const i=cursor++;return slots[i]||(slots[i]={})}
const React={
 useRef(value){const s=slot();if(!('current'in s))s.current=value;return s},
 useState(value){const s=slot();if(!('value'in s))s.value=value;return[s.value,v=>{if(s.value!==v){s.value=v;dirty=true}}]},
 useEffect(fn,deps){const s=slot();if(!s.deps||deps.some((v,i)=>!Object.is(v,s.deps[i]))){s.deps=deps;queue.push(()=>{if(s.cleanup)s.cleanup();s.cleanup=fn()})}}
}
function h(type,props,...children){const el={type,props,style:props?.style||{},firstChild:children.flat(Infinity)[0],getBoundingClientRect:()=>({width:298})};if(props?.ref)props.ref.current=el;return el}
try {
 globalThis.window={addEventListener(){},removeEventListener(){}}
 globalThis.setInterval=(fn,ms)=>{const id=Symbol();timers.set(id,{fn,ms});return id}
 globalThis.clearInterval=id=>timers.delete(id)
 const PeakBar=new Function('React','h',code+';return PeakBar')(React,h)
 function render(props){let tree;for(let i=0;i<4;i++){cursor=0;dirty=false;tree=PeakBar(props);if(hookCount===undefined)hookCount=cursor;assert.equal(cursor,hookCount,'stable hooks');const jobs=queue;queue=[];jobs.forEach(fn=>fn());if(!dirty)break}return tree}
 const now=Date.now(),valid={phase:{inPeak:true,nextAtMs:now+3600000},segs:[{s:now-43200000,e:now+43200000,t:'peak'}]}
 const tree=render(valid)
 check('无 WAAPI / ResizeObserver 仍可渲染真实 PeakBar',()=>assert(tree))
 check('无 RO 时有宽度校准兜底',()=>assert([...timers.values()].some(t=>t.ms===1000)))
 // 捕获 trackRef；动画 fallback 应给真实图案写 transform。
 const trackRef=slots.find(s=>s.current?.props?.['data-peak-track']!==undefined)
 check('无 WAAPI 静态 transform 兜底',()=>assert.match(trackRef.current.firstChild.style.transform,/translateX/))
 render({phase:valid.phase,segs:[]})
 check('有段→缺段 hooks 数量稳定且测量 effect 清理',()=>assert(![...timers.values()].some(t=>t.ms===1000)))
 render(valid);render({phase:null,segs:[]});render(valid)
 check('缺相位与恢复均保持 hooks 顺序',()=>assert.equal(cursor,hookCount))
 render({phase:valid.phase,segs:[{s:1,e:0,t:'peak'}]})
 check('非法时间窗不触发 hooks 次数变化',()=>assert.equal(cursor,hookCount))
} finally {
 for(const s of slots)if(s.cleanup)s.cleanup()
 globalThis.window=originalWindow;globalThis.setInterval=originalSetInterval;globalThis.clearInterval=originalClearInterval
}
console.log('\n全部 '+passed+' 项通过（模拟宿主与 hooks 契约，非 Android 真机）')
