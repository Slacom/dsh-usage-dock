// 设置页回归：
//   1) [0.11.0] 入口已从「设置 → 内置插件 → Usage Dock」tab 搬到**设置主页顶层分区**
//      （settings.section + settings.section.icon），并校验槽位形状、图标几何与卸载语义；
//   2) 原有：无需鼠标悬停即可排序、保存期间锁定草稿、文案与来源一致。
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
  // -------------------------------------------------------------------------
  // [0.11.0] 设置主页顶层分区（settings.section）+ 图标槽位（settings.section.icon）
  // -------------------------------------------------------------------------
  check('设置页组件由 settings.section 槽位提供（不再是内置插件 tab）',()=>{
    assert.equal(typeof client.SettingsPage,'function')
    assert.equal(typeof client.SectionIcon,'function')
  })
  check('只注册设置主页顶层分区，不再注册 settings.plugins.tab',()=>{
    const tabs=client.slotSpecs.filter(s=>s.name==='settings.plugins.tab')
    const sections=client.slotSpecs.filter(s=>s.name==='settings.section')
    assert.equal(tabs.length,0,'不应再注册 settings.plugins.tab：'+JSON.stringify(tabs.map(s=>s.name)))
    assert.equal(sections.length,1,'应恰好注册一个 settings.section：'+JSON.stringify(sections.map(s=>s.id)))
  })
  check('分区 id=plan-usage、label()=Usage Dock、order 为数字且 ≥16（Codex 订阅=15 之后）',()=>{
    const section=client.slotSpecs.find(s=>s.name==='settings.section')
    assert.equal(section.id,'plan-usage')
    assert.equal(typeof section.label,'function')
    assert.equal(section.label(),'Usage Dock')
    assert.equal(typeof section.order,'number')
    assert.ok(Number.isFinite(section.order)&&section.order>=16,'order 应 ≥16，实际 '+section.order)
    assert.equal(typeof section.inject,'function')
    assert.deepEqual(section.inject(),{form})
  })
  check('图标槽位 id 与分区相同、且与分区成对注册',()=>{
    const section=client.slotSpecs.find(s=>s.name==='settings.section')
    const icons=client.slotSpecs.filter(s=>s.name==='settings.section.icon')
    assert.equal(icons.length,1,'应恰好注册一个 settings.section.icon')
    assert.equal(icons[0].id,section.id)
  })
  check('两个设置槽位都先 slots.inject 等宿主声明、再 register（顺序不限）',()=>{
    // 生产里侧栏席位也走 inject（sidebar.footer.action），不属于本次断言范围，只看 settings.*。
    const settingsInjected=client.injectedSlots.filter(n=>typeof n==='string'&&n.indexOf('settings.')===0)
    assert.deepEqual(settingsInjected.slice().sort(),['settings.section','settings.section.icon'])
    assert.equal(settingsInjected.filter(n=>n==='settings.section').length,1,'settings.section 只应 inject 一次')
    assert.equal(settingsInjected.filter(n=>n==='settings.section.icon').length,1,'settings.section.icon 只应 inject 一次')
  })

  // 图标：实心钱包（Material Symbols "wallet"，Apache-2.0，与 icon.svg 同形）：
  // 只渲染 svg、单条 path、fill:currentColor、无描边；随 size 缩放；active 不改尺寸（只改 opacity）。
  const iconDefault=runtime.mount(client.SectionIcon,{})
  // mock 的 createElement 在单个 child 时把 children 存成元素本身（不包数组），这里统一成数组。
  const iconKids=Array.isArray(iconDefault.props.children)?iconDefault.props.children:[iconDefault.props.children]
  check('图标默认渲染 16×16 svg（24 viewBox / 单条 path / fill:currentColor / 无 stroke / aria-hidden）',()=>{
    assert.equal(iconDefault.type,'svg')
    assert.equal(iconDefault.props.width,16)
    assert.equal(iconDefault.props.height,16)
    assert.equal(iconDefault.props.viewBox,'0 0 24 24')
    assert.equal(iconDefault.props.fill,'none')
    assert.equal(iconDefault.props.stroke,undefined)
    assert.equal(iconDefault.props['aria-hidden'],'true')
    assert.equal(iconDefault.props['data-usage-dock-icon'],'1')
    assert.equal(iconKids.length,1,'实心图标应只渲染 1 个 path（不再有 rect/path/rect 组合）')
    assert.equal(iconKids[0].type,'path')
    assert.equal(iconKids[0].props.fill,'currentColor')
    assert.equal(iconKids[0].props.stroke,undefined)
  })
  check('图标路径与 icon.svg 的 Material Symbols wallet 一致（M6 20 开头且含 M6 8h12 子路径）',()=>{
    const d=iconKids[0].props.d
    assert.equal(typeof d,'string')
    assert.ok(d.startsWith('M6 20'),'路径应以 M6 20 开头，实际：'+String(d).slice(0,32))
    assert.ok(d.includes('M6 8h12'),'路径应包含 M6 8h12 子路径（钱包上盖），实际：'+String(d).slice(0,80))
  })
  const iconSized=runtime.mount(client.SectionIcon,{size:28})
  check('图标宽高随 size 缩放（28×28），viewBox 不变',()=>{
    assert.equal(iconSized.props.width,28)
    assert.equal(iconSized.props.height,28)
    assert.equal(iconSized.props.viewBox,'0 0 24 24')
  })
  const iconActive=runtime.mount(client.SectionIcon,{size:24,active:true})
  check('active 只改视觉权重（opacity 1 vs 0.85），尺寸不变',()=>{
    assert.equal(iconActive.props.width,24)
    assert.equal(iconActive.props.height,24)
    assert.equal(iconActive.props.opacity,1)
    assert.equal(iconDefault.props.opacity,0.85)
    assert.equal(iconActive.props.strokeWidth,undefined,'实心图不应有 strokeWidth')
    assert.equal(iconActive.props['data-usage-dock-icon-active'],'1')
  })

  // -------------------------------------------------------------------------
  // 原有回归：设置页交互（页面组件现在来自 settings.section）
  // -------------------------------------------------------------------------
  let tree=runtime.mount(client.SettingsPage,props)
  check('设置页按实例 this 读取配置，无桌面桥依赖',()=>assert(textOf(tree).includes('Usage Dock')||textOf(tree).includes('启用套餐')))
  check('设置页仍渲染渠道卡片（页面内容未被搬移破坏）',
    ()=>assert(elements(tree).some(n=>n.props&&typeof n.props['data-plan-card']==='string')))
  // [2026-10-21] 国内版改读模型配置里的 WorkBuddy2API 网关，不再依赖 Connect。
  check('WorkBuddy 提示改为读取模型网关配置',()=>assert(textOf(tree).includes('workbuddy 网关配置')))

  // [2026-10-21] 明确点「WorkBuddy 上移」，让后续顺序断言与具体渠道绑定。
  const arrow=elements(tree).find(n=>n.type==='button'&&n.props&&n.props['aria-label']==='WorkBuddy 上移')
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

  // -------------------------------------------------------------------------
  // [0.11.0] 卸载语义：whileServed 返回的组合 disposer 必须把两个槽位都释放。
  // -------------------------------------------------------------------------
  check('[卸载] 两个槽位的 disposer 都被调用',()=>{
    assert.deepEqual(client.disposedSlots.slice(),[],'卸载前不应有已释放槽位')
    client.disposeEffects()
    const disposed=client.disposedSlots.slice().sort()
    assert.deepEqual(disposed,['settings.section','settings.section.icon'])
  })
  console.log('\n全部 '+passed+' 项通过')
} finally {release();client.restore()}
