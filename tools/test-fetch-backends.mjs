/**
 * 取数后端回归测试（0.6.2）。
 *
 * 背景（真机故障）：移动端 DSH（Android APK）里没有 python，curl 也不可用，
 * 而 0.6.1 的 curlJson 只会走 shell + python/curl 两个后端，于是 DeepSeek
 * API Key 取数恒报「upstream request failed」，用户在平板上只看到获取失败。
 * 修复是在 Host 进程里直接用原生 fetch（不需要任何外部可执行文件）。
 *
 * 用法：node tools/test-fetch-backends.mjs
 * 其中 T4/T5 需要出网；离线时自动跳过（不会误报失败）。
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { curlJson } from '../plans/util.js'

/** 模拟平板：shell 服务在，但 python / curl 都不可执行（Android 上没有这两个命令）。 */
function tabletShell() {
  const state = { calls: 0 }
  return {
    state,
    resolve: (spec) => spec,
    run: async (spec) => {
      state.calls += 1
      const bin = String(spec.command).split(' ')[0]
      return {
        exitCode: 127,
        stdout: { text: '' },
        stderr: { text: '/system/bin/sh: ' + bin + ': inaccessible or not found' },
      }
    },
  }
}

const results = []
function record(name, status, note) {
  results.push({ name, status, note })
  console.log('[' + status + '] ' + name + (note ? ' — ' + note : ''))
}

// T1：本地 HTTP 服务，校验头/方法/body 透传，且完全不动用 shell。
{
  const seen = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      seen.push({ method: req.method, headers: req.headers, body })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = 'http://127.0.0.1:' + server.address().port + '/probe'
  const shell = tabletShell()
  try {
    const got = await curlJson(shell, base, {
      auth: 'sk-test',
      cookie: 'jwt-token',
      headers: { 'X-Custom': 'yes' },
    })
    assert.deepEqual(got, { data: { ok: true } })
    const post = await curlJson(shell, base, { method: 'POST', body: JSON.stringify({ a: 1 }) })
    assert.deepEqual(post, { data: { ok: true } })
    assert.equal(shell.state.calls, 0, 'fetch 后端不应调用 shell')

    const [get, p] = seen
    assert.equal(get.method, 'GET')
    assert.equal(get.headers.authorization, 'Bearer sk-test')
    assert.equal(get.headers.cookie, 'kimi-auth=jwt-token', 'Cookie 头必须透传（Kimi 依赖）')
    assert.equal(get.headers['x-custom'], 'yes')
    assert.equal(get.headers.accept, 'application/json')
    assert.equal(p.method, 'POST')
    assert.equal(p.headers['content-type'], 'application/json')
    assert.equal(p.body, JSON.stringify({ a: 1 }))
    record('T1 透传（Authorization/Cookie/自定义头/POST body，零 shell 调用）', 'PASS')
  } catch (err) {
    record('T1 透传', 'FAIL', err.message)
  } finally {
    server.close()
  }
}

// T2：连 shell 服务都没有（ctx.get('shell') === undefined）时也必须能取数。
{
  const seen = []
  const server = createServer((req, res) => {
    seen.push(req.url)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, via: 'no-shell' }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const got = await curlJson(undefined, 'http://127.0.0.1:' + server.address().port + '/x', {})
    assert.deepEqual(got, { data: { ok: true, via: 'no-shell' } })
    assert.equal(seen.length, 1)
    record('T2 无 shell 服务时仍可取数', 'PASS')
  } catch (err) {
    record('T2 无 shell 服务', 'FAIL', err.message)
  } finally {
    server.close()
  }
}

// T3：全部后端都失败时，错误消息必须点名每个后端与原因（0.6.1 只显示一句无信息的话）。
{
  const shell = tabletShell()
  try {
    const got = await curlJson(shell, 'http://127.0.0.1:1/refused', {})
    assert.equal(got.err.error, 'curl')
    assert.match(got.err.message, /fetch:/)
    assert.match(got.err.message, /python: exit 127/)
    assert.match(got.err.message, /curl: exit 127/)
    record('T3 全后端失败时错误消息含逐后端原因', 'PASS', got.err.message)
  } catch (err) {
    record('T3 失败消息聚合', 'FAIL', err.message)
  }
}

// T4（需出网）：平板场景 + 真实上游 —— 无效 Key 应得到「确定性答复」而不是传输层失败。
{
  const shell = tabletShell()
  try {
    const got = await curlJson(shell, 'https://api.deepseek.com/user/balance', {
      auth: 'sk-invalid-probe',
      bearer: true,
    })
    if (got.data !== undefined) {
      record('T4 真实上游（无效 Key）', 'FAIL', '无效 Key 不应返回成功数据')
    } else if (got.err.error === 'curl') {
      record('T4 真实上游（无效 Key）', 'SKIP', '本机未出网：' + got.err.message)
    } else {
      assert.equal(got.err.error, 'authentication_error')
      assert.equal(shell.state.calls, 0, 'fetch 成功后不应回落到 shell')
      record('T4 真实上游（无效 Key）返回确定性鉴权错误，零 shell 调用', 'PASS')
    }
  } catch (err) {
    record('T4 真实上游（无效 Key）', 'FAIL', err.message)
  }
}

// T5（需出网 + 本机有 python）：把原生 fetch 打坏，确认 Python shim 兜底仍然有效
// ——即「必须走系统代理」的 Windows 环境不会因为新增 fetch 后端而退化。
//
// 注意：本仓库的开发环境（DSH 沙箱）禁止父进程用管道捕获子进程输出
// （spawn ... EPERM），所以这里把子进程的 stdout/stderr 重定向到临时文件再读，
// 而不是用 execFileSync 的默认管道。
{
  const realFetch = globalThis.fetch
  const { spawnSync } = await import('node:child_process')
  const { openSync, closeSync, readFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const shell = {
    resolve: (spec) => spec,
    run: async (spec) => {
      const file = join(tmpdir(), 'dsh-fetch-test-' + Date.now() + '-' + Math.random().toString(16).slice(2) + '.log')
      const fd = openSync(file, 'w')
      let res
      try {
        res = spawnSync(spec.command, {
          shell: true,
          env: { ...process.env, ...(spec.env || {}) },
          stdio: ['ignore', fd, fd],
        })
      } finally {
        closeSync(fd)
      }
      let text = ''
      try {
        text = readFileSync(file, 'utf8')
      } finally {
        rmSync(file, { force: true })
      }
      return {
        exitCode: typeof res.status === 'number' ? res.status : 1,
        stdout: { text },
        stderr: { text: '' },
      }
    },
  }
  try {
    globalThis.fetch = async () => { throw new Error('simulated: fetch blocked') }
    const got = await curlJson(shell, 'https://api.deepseek.com/user/balance', {
      auth: 'sk-invalid-probe',
      bearer: true,
    })
    if (got.data !== undefined) {
      record('T5 fetch 失败时 Python shim 兜底', 'FAIL', '无效 Key 不应返回成功数据')
    } else if (got.err.error === 'curl') {
      record('T5 fetch 失败时 Python shim 兜底', 'SKIP', '本机无 python 或未出网：' + got.err.message)
    } else {
      assert.equal(got.err.error, 'authentication_error')
      record('T5 fetch 失败时 Python shim 兜底（确定性错误）', 'PASS')
    }
  } catch (err) {
    record('T5 Python shim 兜底', 'FAIL', err.message)
  } finally {
    globalThis.fetch = realFetch
  }
}

// T6/T7：直接驱动真实的 plans/deepseek.js（本次故障的现场模块）。
// 用 stub 版的全局 fetch 返回 DeepSeek 官方响应结构，因此不需要真实 Key、
// 也不出网；shell 仍是「平板」那套（python/curl 全废）。
{
  const realFetch = globalThis.fetch
  const DEEPSEEK_BALANCE = {
    is_available: true,
    balance_infos: [
      { currency: 'CNY', total_balance: '11.38', granted_balance: '0.00', topped_up_balance: '11.38' },
    ],
  }
  let intercepted = 0
  globalThis.fetch = async (url, init) => {
    if (String(url).indexOf('api.deepseek.com') === -1) return realFetch(url, init)
    intercepted += 1
    assert.equal(init.headers.Authorization, 'Bearer sk-tablet-test')
    return new Response(JSON.stringify(DEEPSEEK_BALANCE), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  try {
    let deepseek
    try {
      deepseek = (await import('../plans/deepseek.js')).default
    } catch (err) {
      // 渠道模块依赖 DSH 运行时的 @deepseek-ai/schemastery；仓库里没有它时跳过，
      // 而不是把环境缺失报成测试失败。装法见 AGENTS.md 第 4 节。
      if (/Cannot find package '@deepseek-ai\//.test(String(err && err.message))) {
        record('T6/T7 plans/deepseek.js 端到端', 'SKIP', '缺少 @deepseek-ai/schemastery（见 AGENTS.md 第 4 节）')
        deepseek = null
      } else {
        throw err
      }
    }

    if (deepseek === null) {
      // 依赖缺失，已在上面记录 SKIP。
    } else {
    // T6：平板场景 —— 没有账号服务（ctx.get('deepseekAccount') === undefined）、
    // python/curl 都不可用，只有配置里的 API Key。0.6.1 在这里必然失败。
    const shell = tabletShell()
    const out = await deepseek.fetch(
      { get: () => undefined },
      shell,
      { deepseekApiKey: 'sk-tablet-test', deepseekWarnThreshold: 10 },
    )
    assert.equal(out.id, 'deepseek')
    assert.equal(out.via, 'api', '应走 API Key 数据源')
    assert.equal(out.balance, 11.38)
    assert.equal(out.isAvailable, true)
    assert.equal(out.warnThreshold, 10)
    assert.equal(intercepted, 1)
    assert.equal(shell.state.calls, 0, '不应回落到 python/curl')
    record('T6 平板场景：DeepSeek API Key 正确读出余额 ¥11.38（零 shell 调用）', 'PASS')

    // T7：桌面端账号余额仍然优先（含赠金），且不发起任何 HTTP 请求。
    const before = intercepted
    const accountOut = await deepseek.fetch(
      {
        get: (name) => (name === 'deepseekAccount'
          ? {
              getBalance: async () => ({
                status: 'ready',
                value: [{ currency: 'CNY', balance: '20.50' }],
                bonusWallets: [{ currency: 'CNY', balance: '5.00' }],
              }),
            }
          : undefined),
      },
      tabletShell(),
      { deepseekApiKey: 'sk-tablet-test' },
    )
    assert.equal(accountOut.via, 'account')
    assert.equal(accountOut.balance, 25.5, '应把赠金一并计入')
    assert.equal(intercepted, before, '账号可用时不应发起 API 请求')
    record('T7 桌面端账号余额优先（20.50 + 赠金 5.00 = 25.50）且不发请求', 'PASS')
    }
  } catch (err) {
    record('T6/T7 plans/deepseek.js 端到端', 'FAIL', err.message)
  } finally {
    globalThis.fetch = realFetch
  }
}

// T8：所有渠道在「没有 shell 服务、没有凭据」时都必须返回结构化结果而不是抛异常
// ——index.js 已不再因为 shell 缺失整体 503，这条守住那个降级路径。
{
  try {
    let PLANS
    try {
      ({ PLANS } = await import('../plans/index.js'))
    } catch (err) {
      if (/Cannot find package '@deepseek-ai\//.test(String(err && err.message))) {
        record('T8 全渠道无 shell 降级', 'SKIP', '缺少 @deepseek-ai/schemastery（见 AGENTS.md 第 4 节）')
        PLANS = null
      } else {
        throw err
      }
    }
    if (PLANS !== null) {
      const ctx = { get: () => undefined }
      const out = await Promise.all(PLANS.map((plan) => plan.fetch(ctx, undefined, {})))
      assert.equal(out.length, PLANS.length)
      for (const wire of out) {
        assert.equal(typeof wire, 'object', '渠道结果必须是对象')
        assert.equal(typeof wire.id, 'string')
        assert.equal(typeof wire.name, 'string')
        // 无凭据的应报 no-key；Codex 例外：它依赖 dsh-codex-connect，未装时
        // 报 not-installed / incompatible。关键是不能抛异常、不能返回 undefined。
        assert.ok(
          wire.error === 'no-key' || wire.error === 'incompatible' || wire.error === 'not-installed',
          '无凭据时应给出 no-key/incompatible/not-installed，实际: ' + JSON.stringify(wire),
        )
      }
      record('T8 全渠道（' + PLANS.length + ' 个）在无 shell / 无凭据时降级正常', 'PASS')
    }
  } catch (err) {
    record('T8 全渠道无 shell 降级', 'FAIL', err.message)
  }
}

const failed = results.filter((r) => r.status === 'FAIL')
const skipped = results.filter((r) => r.status === 'SKIP')
console.log('\n' + results.length + ' 项：' + (results.length - failed.length - skipped.length) + ' 通过, ' + failed.length + ' 失败, ' + skipped.length + ' 跳过')
process.exit(failed.length === 0 ? 0 : 1)
