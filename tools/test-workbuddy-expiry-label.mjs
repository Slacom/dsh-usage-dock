// Real client renderer + synthetic wire only. No gateway/profile/credential access.
import {createRuntime,loadClient,textOf} from './mock-react.mjs'
// [A3 修复] 胶囊的 30s 轮询是真实 setTimeout 链：每个 case 虽在 finally 里 restore()，
// 已排上的长定时器仍让进程不退出（实测 120s 仍 Running）。这里把 ≥1s 的定时器吞掉
// （返回假 id、不保留句柄），0ms 调度照常；断言全部依赖 settle，不依赖长定时器。
const realSetTimeout=globalThis.setTimeout
globalThis.setTimeout=(fn,ms,...rest)=>(typeof ms==='number'&&ms>=1000?0:realSetTimeout(fn,ms,...rest))
let passed=0,failed=0
function check(name,ok){if(ok){passed++;console.log('[PASS] '+name)}else{failed++;console.log('[FAIL] '+name)}}
async function detail(account){
 const runtime=createRuntime(),props={wide:true,configForm:null}
 const payload={ok:true,data:{plans:[{id:'workbuddy',name:'WorkBuddy',creditsTotal:90,creditsUnlimited:false,isAvailable:true,variants:[{label:'WorkBuddy',total:90,unlimited:false}],creditsAccounts:[{variant:'WorkBuddy',packageName:null,remain:90,size:null,endTimeMs:null},account]}]}}
 const client=loadClient(runtime,{payload})
 try{runtime.mount(client.Badge,props);let tree=await runtime.settle(props);tree.props.children[0].props.onClick();tree=await runtime.settle(props);return textOf(tree)}finally{client.restore()}
}
const localDate=new Date(2030,9,31,12,0,0).getTime()
const subset={variant:'WorkBuddy',packageName:'其中最早到期部分',remain:14,size:null,subsetOfAccount:true,endTimeMs:localDate}
let text=await detail(subset)
check('actual date shown as recent expiry YYYY-MM-DD',text.includes('最近到期 2030-10-31：14'))
check('old long label removed from detail',!text.includes('其中最早到期部分'))
check('aggregate remains but duplicate ordinary summary is hidden',!text.includes('WorkBuddy · 套餐：90')&&text.includes('90'))
text=await detail({...subset,endTimeMs:new Date(2031,1,3,12).getTime()})
check('date is derived, not hardcoded to example',text.includes('最近到期 2031-02-03：14')&&!text.includes('2026-10-31'))
for(const [name,stamp]of [['null',null],['absent',undefined],['NaN',NaN],['Infinity',Infinity],['invalid Date range',1e30],['numeric string',String(localDate)]]){
 text=await detail({...subset,endTimeMs:stamp});check(name+' falls back to plain recent expiry',text.includes('最近到期：14')&&!/最近到期 (?:NaN|Invalid|undefined|null)/.test(text))
}
text=await detail({...subset,subsetOfAccount:undefined})
check('old-wire label is supported without subset marker',text.includes('最近到期 2030-10-31：14'))
text=await detail({...subset,subsetOfAccount:false,packageName:'SYNTHETIC_PACKAGE'})
check('ordinary named package is not relabeled',text.includes('SYNTHETIC_PACKAGE：14')&&!text.includes('最近到期'))
text=await detail({...subset,subsetOfAccount:false,packageName:null,endTimeMs:null,remain:45})
check('non-duplicate ordinary account detail remains visible',text.includes('WorkBuddy · 套餐：45'))
text=await detail({...subset,remain:90})
check('expiry portion equal to total is not hidden',text.includes('最近到期 2030-10-31：90'))
text=await detail({...subset,subsetOfAccount:false,packageName:'SYNTHETIC_PACKAGE',remain:90})
check('named package equal to total is not hidden',text.includes('SYNTHETIC_PACKAGE：90'))
const midnight=new Date(2030,9,31,0,15).getTime();text=await detail({...subset,endTimeMs:midnight})
check('local day boundary is not converted to UTC date',text.includes('最近到期 2030-10-31：14'))
console.log(JSON.stringify({passed,failed,realRequests:0,timeZone:Intl.DateTimeFormat().resolvedOptions().timeZone}))
if(process.argv.includes('--expect-red')){if(failed===0)process.exitCode=1;else console.log('EXPECTED_RED: requested detail change is not implemented yet')}else if(failed)process.exitCode=1
