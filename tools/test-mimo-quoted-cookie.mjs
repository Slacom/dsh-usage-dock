// Minimal approved compatibility exception: exact wire quotes, legacy default,
// malformed values, domain/path/expiry, and the actual console outbound authority.
// No DNS, network, configuration, auth data, or installed-plugin reads.
import assert from 'node:assert/strict'
import { CookieJar, JAR_CODES } from '../plans/mimo-auth/vendor/cookie-jar.js'
import { createConsoleGrantAuthority } from '../plans/mimo-auth/console-grants.js'
let passed=0
const failed=[]
function check(name,fn){try{fn();passed++}catch(e){failed.push(name+' :: '+e.message)}}
const HOST='https://platform.xiaomimimo.com'
const LINE='api-platform_serviceToken="SYNTHETIC+/="; Path=/; Secure; HttpOnly'
const jar=opts=>new CookieJar({rootDomains:['platform.xiaomimimo.com'],...opts})

check('旧调用默认/false/非布尔 true 均拒引号，普通值行为不变',()=>{
  for(const option of [{},{allowQuotedValues:false},{allowQuotedValues:'true'}]){
    const j=jar(option)
    assert.equal(j.absorb([LINE],HOST+'/sts').rejected[0].code,JAR_CODES.BAD_VALUE)
    assert.equal(j.size,0)
    assert.equal(j.absorb(['userId=777; Path=/; Secure'],HOST+'/sts').accepted,1)
    assert.equal(j.cookieHeaderFor(HOST+'/api/v1/balance').header,'userId=777')
    j.clear()
  }
})
check('仅显式 true 接受合法双引号，Header 原样保留不转码',()=>{
  const j=jar({allowQuotedValues:true})
  assert.equal(j.absorb([LINE],HOST+'/sts').accepted,1)
  assert.equal(j.cookieHeaderFor(HOST+'/api/v1/balance').header,'api-platform_serviceToken="SYNTHETIC+/="')
  assert.equal(JSON.stringify(j).includes('SYNTHETIC'),false)
  j.clear();assert.equal(j.cookieHeaderFor(HOST+'/api/v1/balance').header,null)
})
check('引号内部空格/逗号/反斜杠/内嵌引号/缺边界/非ASCII仍拒',()=>{
  for(const value of ['"A B"','"A,B"','"A\\B"','"A"B"','"A','A"','"A\tB"','"中文"']){
    const j=jar({allowQuotedValues:true})
    assert.equal(j.absorb(['userId='+value+'; Path=/; Secure'],HOST+'/sts').rejected[0].code,JAR_CODES.BAD_VALUE)
    assert.equal(j.size,0)
    j.clear()
  }
})
check('原始大小与 CRLF 在任何兼容处理之前检查',()=>{
  const j=jar({allowQuotedValues:true})
  assert.equal(j.absorb(['userId="A\r\nB"; Path=/; Secure'],HOST+'/sts').rejected[0].code,JAR_CODES.CRLF)
  assert.equal(j.absorb(['userId="'+'A'.repeat(4090)+'"; Path=/'],HOST+'/sts').rejected[0].code,JAR_CODES.TOO_LARGE)
  assert.equal(j.size,0)
})
check('启用引号仍保留域/Path/Secure/Max-Age/删除',()=>{
  let now=100000
  const j=jar({allowQuotedValues:true,now:()=>now})
  assert.equal(j.absorb(['userId="777"; Domain=.evil.example; Path=/; Secure'],HOST+'/sts').rejected[0].code,JAR_CODES.FOREIGN_DOMAIN)
  assert.equal(j.absorb(['userId="777"; Path=/api/; Max-Age=1; Secure'],HOST+'/sts').accepted,1)
  assert.equal(j.cookieHeaderFor('http://platform.xiaomimimo.com/api/v1/balance').header,null)
  assert.equal(j.cookieHeaderFor(HOST+'/elsewhere').header,null)
  assert.equal(j.cookieHeaderFor('https://other.xiaomimimo.com/api/v1/balance').header,null)
  assert.equal(j.cookieHeaderFor(HOST+'/api/v1/balance').header,'userId="777"')
  now+=1001
  assert.equal(j.cookieHeaderFor(HOST+'/api/v1/balance').header,null)
  j.absorb(['userId="777"; Path=/; Secure'],HOST+'/sts')
  assert.equal(j.absorb(['userId="777"; Path=/; Max-Age=0; Secure'],HOST+'/sts').deleted,1)
  assert.equal(j.size,0)
})
function authority(){return createConsoleGrantAuthority({owner:{},bootEpoch:'synthetic-boot',generation:1,deadlineAt:10000,now:()=>1000,isLive:()=>true})}
check('真实用途授权允许合法引号 Header，不更改调用者原值',()=>{
  const a=authority()
  const url=HOST+'/api/v1/balance'
  const grant=a.issue({url,purpose:'consoleBalance',credentialClass:'platform'})
  const cookie='api-platform_serviceToken="SYNTHETIC+/="; userId="777"'
  const headers={cookie}
  assert.equal(a.validate(grant,{url,method:'GET',purpose:'consoleBalance',credentialClass:'platform',headers}),true)
  assert.equal(headers.cookie,cookie)
  a.invalidate()
})
check('用途校验不接受损坏引号、注入、空凭据或账号票串入平台',()=>{
  for(const cookie of ['api-platform_serviceToken="A B"; userId=777','api-platform_serviceToken="A; userId=777"','api-platform_serviceToken="A\\B"; userId=777','api-platform_serviceToken="A; userId=777','api-platform_serviceToken=""; userId=777','passToken="A"; userId=777']){
    const a=authority()
    const url=HOST+'/api/v1/balance'
    const grant=a.issue({url,purpose:'consoleBalance',credentialClass:'platform'})
    assert.throws(()=>a.validate(grant,{url,method:'GET',purpose:'consoleBalance',credentialClass:'platform',headers:{cookie}}),e=>e.code==='E_MIMO_AUTH_TARGET_INVALID')
    a.invalidate()
  }
})
check('无 Cookie 用途即使合法引号仍拒绝任何 Cookie',()=>{
  const a=authority()
  const url=HOST+'/api/v1/genLoginUrl?currentPath=%2Fconsole%2Fplan-manage'
  const grant=a.issue({url,purpose:'consoleContext',credentialClass:'none'})
  assert.throws(()=>a.validate(grant,{url,method:'GET',purpose:'consoleContext',credentialClass:'none',headers:{cookie:'userId="777"'}}),e=>e.code==='E_MIMO_AUTH_TARGET_INVALID')
  a.invalidate()
})
console.log(passed+' passed, '+failed.length+' failed')
for(const message of failed)console.log('FAIL '+message)
if(failed.length>0)process.exitCode=1
