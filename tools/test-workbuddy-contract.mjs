// 用移植包真实的 status handler 对接本插件，不加载/读取任何真实认证文件。
// node tools/test-workbuddy-contract.mjs <解压后的 dsh-workbuddy-connect/lib/index.js>
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import assert from 'node:assert/strict'
import { setWebBase, fetchPlan } from '../plans/workbuddy.js'
const file=process.argv[2]
if(!file)throw new Error('请指定待验证的 WorkBuddy Connect lib/index.js')
const source=readFileSync(file,'utf8')
const loopStart=source.indexOf('const LOOPBACK_HOSTS ='),statusStart=source.indexOf('function safeMessage(error)')
assert(loopStart>=0&&statusStart>=0,'recognised upstream source')
const loop=source.slice(loopStart,source.indexOf('//#endregion',loopStart))
const status=source.slice(statusStart,source.indexOf('//#endregion',statusStart))
const makeHandler=new Function(loop+'\n'+status+';return workBuddyStatusHandler')()
const credits={total:1906,accounts:[{packageName:'个人体验版',remain:500,size:500},{packageName:'拉新权益包',remain:1000,size:1000},{packageName:'其他积分',remain:406,size:500}]}
// [0.8.5] 两组失败场景：语义错误（登录失效 → api）与暂时错误（限流 → exec + transient）。
// connect 侧的 fetchCredits 抛出什么就包装成 `workbuddy upstream <kind> (http <status>): <msg>`
// （见其 envelopeError），因此这里用同样形状的错误来模拟，而不是裸文本。
let billingError=null,billingCalls=0
const cn=makeHandler({
 store:{status:async()=>({state:'signed-in',source:'plugin-copy'}),current:async()=>({synthetic:true})},
 client:{fetchCredits:async()=>{
  billingCalls++
  if(billingError!==null)throw new Error(billingError)
  return credits
 }},
 models:()=>[]
})
const ai=makeHandler({store:{status:async()=>({state:'signed-out'})},models:()=>[]})
const server=createServer((req,res)=>{
 const handler=req.url==='/plugins/dsh-workbuddy-connect/status'?cn:req.url==='/plugins/dsh-workbuddy-connect/ai/status'?ai:null
 if(handler)handler(req,res);else{res.writeHead(404);res.end('{}')}
})
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
try {
 const base='http://127.0.0.1:'+server.address().port
 setWebBase(base)
 const wire=await fetchPlan()
 assert.equal(wire.creditsTotal,1906);assert.equal(wire.creditsAccounts.length,3);assert.equal(wire.isAvailable,true)
 console.log('[PASS] 真实移植包 status handler → Usage Dock 合计1906与3项明细')
 assert.equal(wire.variants.length,1);assert.equal(wire.variants[0].label,'WorkBuddy')
 console.log('[PASS] CN 自有副本登录 / AI 未登录，不要求安卓安装桌面应用')
 assert.equal(billingCalls,1)
 console.log('[PASS] 不调用 shell，不读取桌面凭据，仅一次积分读取')
 const denied=await fetch(base+'/plugins/dsh-workbuddy-connect/status',{headers:{Origin:'https://untrusted.example'}})
 assert.equal(denied.status,403)
 console.log('[PASS] 未绕过上游 Host/Origin 安全限制')

 // 语义错误：登录失效 → 立即报错（api），且不伪造余额。
 billingError='workbuddy upstream session_dead (http 401): synthetic token expired'
 const signedOut=await fetchPlan()
 assert.equal(signedOut.error,'api')
 assert.equal(signedOut.transient,undefined)
 assert(signedOut.message.includes('synthetic token expired'))
 assert.equal(signedOut.creditsTotal,undefined)
 console.log('[PASS] 登录失效（session_dead）→ api 语义错误，不伪造余额')

 // 暂时错误：限流 → exec + transient，交给客户端灰化保旧值。
 billingError='workbuddy upstream soft_rate (http 429): usage exceeds frequency limit'
 const rateLimited=await fetchPlan()
 assert.equal(rateLimited.error,'exec')
 assert.equal(rateLimited.transient,true)
 assert.equal(rateLimited.creditsTotal,undefined)
 console.log('[PASS] 限流（soft_rate 429）→ exec + transient，客户端可灰化保旧值')

 // 冲突文案：上游消息里混入「http 401」，但前缀是 soft_rate → 仍按暂时处理。
 billingError='workbuddy upstream soft_rate (http 429): your token appears invalid (http 401)'
 const conflicting=await fetchPlan()
 assert.equal(conflicting.error,'exec','前缀 kind 必须优先于正文里的 401 字样')
 assert.equal(conflicting.transient,true)
 console.log('[PASS] 冲突文案（soft_rate 前缀 + 正文 401）仍判暂时失败')
 console.log('\n7项真实源码接口契约通过（模拟认证/计费，非手机联网实测）')
} finally {setWebBase(null);await new Promise(resolve=>server.close(resolve))}
