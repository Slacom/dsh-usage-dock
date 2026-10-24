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
  // [0.9.0] 本版新增了第二条路由（/api/plan-usage/custom-status）：这里按路径取
  // 用量路由，不再假设「最后一次 register 就是用量路由」。
  apply({ get, webServer: { port: 12345, register(spec) { if (spec.path === '/api/plan-usage') handler=spec.handler; return ()=>{} } }, effect: fn=>fn() }, config)
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
  // [0.8.3] 峰谷条不再限定账号模式：API Key 计费同样按平台峰谷规则计价，
  // 因此 Host 必须给 API Key 的 DeepSeek 条目也附 peakPhase + peakSegs。
  check('API Key 模式也附峰谷相位与段序列（0.8.3 放宽）',()=>{
    const p = response.body.data.plans[0]
    assert.equal(typeof p.peakPhase,'object')
    // 不断言当前是峰还是谷——那取决于运行时刻（峰窗口为北京时间 09:00–12:00 /
    // 14:00–18:00，周末与假日全谷价）。只校验相位结构完整。
    assert.equal(typeof p.peakPhase.inPeak,'boolean')
    assert.equal(typeof p.peakPhase.weekend,'boolean')
    assert.equal(typeof p.peakPhase.nextAtMs,'number')
    assert.ok(Array.isArray(p.peakSegs)&&p.peakSegs.length>0,'peakSegs 应非空')
    // 段窗口必须覆盖「游标左 12h」——客户端可视窗 = 24h（游标居中）。
    const now=Date.now()
    assert.ok(p.peakSegs[0].s<=now-12*3600e3,'段起点应不晚于 now-12h')
    assert.ok(p.peakSegs[p.peakSegs.length-1].e>=now+12*3600e3,'段终点应不早于 now+12h')
    // 每段都必须是合法类型（客户端按这些值取色）。
    for (const seg of p.peakSegs) {
      assert.ok(['peak','off','weekend','holiday'].includes(seg.t),'未知段类型 '+seg.t)
      assert.ok(seg.e>seg.s,'段区间应递增')
    }
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
  // 这里改 mock：模拟安卓端未安装可选的 WorkBuddy Connect。
  globalThis.fetch=async()=>({status:404,json:async()=>({})})
  // [2026-10-21] 国内版改读 WorkBuddy2API 网关（来自模型配置），**不再依赖** Connect 是否安装；
  // 国际版仍走 Connect 端点，未安装时仍是 not-installed。
  // [2026-10-21] workbuddy-ai 已退场：现在只剩一个国内渠道。
  const missing=await request(handlerFor({...disabled,workbuddyEnabled:true}))
  check('国内版按模型网关状态取数（不再依赖 Connect）',()=>{
    assert.equal(missing.body.data.plans.length,1)
    assert.equal(missing.body.data.plans[0].id,'workbuddy')
    // 国内版：该宿主没有模型目录 → 能力不可用（不再是 not-installed）。
    assert.equal(missing.body.data.plans[0].error,'unavailable')
  })
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
