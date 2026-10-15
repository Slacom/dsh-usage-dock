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
let billingError=false,billingCalls=0
const cn=makeHandler({
 store:{status:async()=>({state:'signed-in',source:'plugin-copy'}),current:async()=>({synthetic:true})},
 client:{fetchCredits:async()=>{billingCalls++;if(billingError)throw new Error('synthetic token expired');return credits}},
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
 billingError=true
 const failed=await fetchPlan()
 assert.equal(failed.error,'api');assert(failed.message.includes('synthetic token expired'));assert.equal(failed.creditsTotal,undefined)
 console.log('[PASS] 上游积分异常正确透传而非显示伪造余额')
 console.log('\n5项真实源码接口契约通过（模拟认证/计费，非手机联网实测）')
} finally {setWebBase(null);await new Promise(resolve=>server.close(resolve))}
