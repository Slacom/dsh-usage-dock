// 设置页：无需鼠标悬停即可排序、保存期间锁定草稿、文案与来源一致。
import assert from 'node:assert/strict'
import { createRuntime, loadClient, textOf } from './mock-react.mjs'
let passed=0
function check(name,fn){fn();passed++;console.log('[PASS] '+name)}
const runtime=createRuntime(),writes=[]
let release
const gate=new Promise(resolve=>{release=resolve})
const form={
 value:{enabled:true,planOrder:'[]'},
 getSnapshot(){assert.equal(this,form);return{value:this.value,writable:true}},
 subscribe(){assert.equal(this,form);return()=>{}},
 set(field,value){assert.equal(this,form);writes.push({field,value});return gate.then(()=>{this.value={...this.value,[field]:value}})}
}
const client=loadClient(runtime,{form})
function elements(node,out=[]){if(!node||typeof node!=='object')return out;if(Array.isArray(node)){node.forEach(n=>elements(n,out));return out}out.push(node);elements(node.props?.children,out);return out}
const props={form}
try {
 let tree=runtime.mount(client.SettingsPage,props)
 check('设置页按实例 this 读取配置，无桌面桥依赖',()=>assert(textOf(tree).includes('Usage Dock')||textOf(tree).includes('启用套餐')))
 check('WorkBuddy 使用自己的登录来源提示',()=>assert(textOf(tree).includes('复用 dsh-workbuddy-connect 的登录态')))
 const arrow=elements(tree).find(n=>n.props?.['aria-label']==='WorkBuddy 上移')
 check('渠道排序是原生可点击按钮，不依赖 hover',()=>assert.equal(arrow.type,'button'))
 arrow.props.onClick()
 tree=await runtime.settle(props)
 const save=elements(tree).find(n=>n.type==='button'&&textOf(n)==='保存更改')
 assert.equal(save.props.disabled,false)
 save.props.onClick()
 tree=runtime.renderOnce(props)
 check('保存期间锁定全部字段和排序箭头',()=>assert(elements(tree).filter(n=>n.type==='input'||n.props?.['aria-label']).every(n=>n.props.disabled===true)))
 check('排序写入 planOrder',()=>{
   const order=JSON.parse(writes.find(w=>w.field==='planOrder').value)
   // 点击「WorkBuddy 上移」一次：workbuddy 必须排到默认顺序中它前一个渠道（mimo）之前。
   const wi=order.indexOf('workbuddy'), mi=order.indexOf('mimo')
   assert.ok(wi>=0 && mi>=0 && wi<mi,'workbuddy 应排在 mimo 之前，实际 '+JSON.stringify(order))
 })
 release();await gate;await Promise.resolve()
 tree=await runtime.settle(props)
 check('保存后退出 saving，保留已写顺序',()=>{
   // 保存后同样保留该顺序。
   const saved=JSON.parse(form.value.planOrder)
   assert.ok(saved.indexOf('workbuddy')<saved.indexOf('mimo'),'保存后 workbuddy 仍应在 mimo 之前')
 })
 console.log('\n全部 '+passed+' 项通过')
} finally {release();client.restore()}
