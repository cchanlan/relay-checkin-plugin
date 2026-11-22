/**
 * apikey.casa 隔离回归：全部使用假 token + mock fetch，不访问真实站点、不领取奖励。
 * 只能在不含 data/ 的独立插件副本运行：node test/apikeycasa.mjs。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DATA = path.join(ROOT, 'data')
if (fs.existsSync(DATA)) throw new Error('请在不含 data/ 的独立插件副本运行，不能使用在线插件目录')

const TOKEN = 'FAKE_AUTH_TOKEN_FOR_TEST_ONLY'
const URL = 'https://apikey.casa/api/v1/redeem/checkin'
const ACCOUNT = { name: 'apikey.casa', baseUrl: 'https://apikey.casa', type: 'apikeycasa', token: TOKEN }
const logs = []
global.logger = Object.fromEntries(['info', 'mark', 'warn', 'error'].map(k => [k, (...args) => logs.push(args.join(' '))]))
global.Bot = { uin: 10000 }
const { installHost } = await import('../host/index.js')
const { createTrssHost } = await import('../host/trss.js')
installHost(createTrssHost())

let routes = {}
const calls = []
const realFetch = global.fetch
global.fetch = async (url, opts = {}) => {
  const key = `${opts.method || 'GET'} ${url}`
  calls.push(key)
  const handler = routes[key]
  assert.ok(handler, `mock fetch 未定义路由: ${key}`)
  const response = typeof handler === 'function' ? await handler(opts) : handler
  return {
    status: response.status ?? 200,
    text: async () => JSON.stringify(response.body ?? null),
    headers: { get: () => 'application/json', getSetCookie: () => [] }
  }
}
const statusBody = (checked = false, reward = 5) => ({ code: 0, message: 'success', data: { checked_in: checked, reward, date: '2000-01-01' } })
function reset(get, post) {
  calls.length = 0
  routes = { [`GET ${URL}`]: get }
  if (post) routes[`POST ${URL}`] = post
}
const postCalls = () => calls.filter(c => c.startsWith('POST ')).length
let passed = 0
async function test(name, fn) { await fn(); passed++; console.log(`OK ${name}`) }
let failed = false

try {
  const { getConfig } = await import('../models/config.js')
  const cfg = getConfig()
  cfg.security.allowedPrivateHosts = ['apikey.casa']
  cfg.proxy = { url: '', hosts: [], useForBrowser: false }
  cfg.browser.enable = false
  cfg.request.retry = 2
  const { getAdapter, probeAccount, isApikeyCasaHost, preferredBindingForHost } = await import('../models/adapters/index.js')
  const adapter = getAdapter('apikeycasa')
  const { checkinAccount } = await import('../models/executor.js')

  await test('官方主机严格识别与适配器注册', async () => {
    for (const host of ['apikey.casa', 'APIKEY.CASA', 'apikey.casa.']) assert.equal(isApikeyCasaHost(host), true)
    for (const host of ['', null, 'apikey.casa.evil.test', 'evil-apikey.casa', 'sub.apikey.casa']) assert.equal(isApikeyCasaHost(host), false)
    assert.equal(adapter.type, 'apikeycasa')
    assert.equal(preferredBindingForHost('apikey.casa'), null)
  })

  await test('账号探测只读专用接口与 Bearer 鉴权', async () => {
    reset(opts => {
      assert.equal(opts.headers.Authorization, `Bearer ${TOKEN}`)
      return { body: statusBody(false) }
    })
    const probe = await probeAccount(ACCOUNT.baseUrl, TOKEN, null)
    assert.equal(probe.ok, true)
    assert.equal(probe.type, 'apikeycasa')
    assert.equal(probe.info.balanceText, '-')
    assert.equal(probe.info.quota, null)
    assert.equal(probe.info.siteUserId, null)
    assert.equal(probe.info.checkedIn, false)
    assert.deepEqual(calls, [`GET ${URL}`])
  })

  await test('无效 token 探测不回退 new-api/Veloera', async () => {
    reset({ status: 401, body: { code: 'UNAUTHORIZED', message: TOKEN } })
    const probe = await probeAccount(ACCOUNT.baseUrl, TOKEN, '9')
    assert.equal(probe.ok, false)
    assert.match(probe.msg, /重新登录.*更新 Auth token/)
    assert.ok(!probe.msg.includes(TOKEN))
    assert.deepEqual(calls, [`GET ${URL}`])
  })

  await test('未签状态不虚报已领取奖励', async () => {
    reset({ body: statusBody(false) })
    const state = await adapter.getCheckinStatus(ACCOUNT)
    assert.equal(state.ok, true)
    assert.equal(state.checked, false)
    assert.equal(state.enabled, true)
    assert.equal(state.reward, 5)
    assert.equal(state.awardText, null)
    assert.equal(state.awardQuota, null)
  })

  await test('已签奖励直接格式化美元并保留小数', async () => {
    for (const [reward, expected] of [[5, '$5.00'], ['2.125', '$2.125'], [0.005, '$0.005'], [0, '$0.00']]) {
      reset({ body: statusBody(true, reward) })
      const state = await adapter.getCheckinStatus(ACCOUNT)
      assert.equal(state.awardText, expected)
      assert.equal(state.awardQuota, null)
      assert.equal(state.balanceText, '-')
    }
  })

  await test('异常状态或奖励不能提交签到', async () => {
    const badBodies = [
      { code: 0, data: { checked_in: 'false', reward: 5 } },
      { code: 0, data: { reward: 5 } },
      ...[null, '', false, -1, 'NaN', 'Infinity'].map(reward => statusBody(false, reward)),
      { code: 1, message: TOKEN }, null
    ]
    for (const body of badBodies) {
      reset({ body })
      const result = await adapter.checkin(ACCOUNT)
      assert.equal(result.ok, false)
      assert.equal(postCalls(), 0)
      assert.ok(!result.msg.includes(TOKEN))
    }
  })

  await test('GET 的 401/403/INVALID_TOKEN 都提示重新登录', async () => {
    for (const response of [{ status: 401 }, { status: 403 }, { status: 200, body: { code: 'INVALID_TOKEN', message: TOKEN } }]) {
      reset(response)
      const result = await adapter.checkin(ACCOUNT)
      assert.equal(result.ok, false)
      assert.match(result.msg, /重新登录.*更新 Auth token/)
      assert.equal(postCalls(), 0)
    }
  })

  await test('404 和网络错误保持失败而非不支持/误提交', async () => {
    reset({ status: 404, body: {} })
    const state = await adapter.getCheckinStatus(ACCOUNT)
    assert.equal(state.supported, true)
    assert.equal(state.ok, false)
    reset(() => { throw new Error('test GET unavailable') })
    assert.equal((await adapter.checkin(ACCOUNT)).ok, false)
    assert.equal(postCalls(), 0)
  })

  await test('直接调用适配器：已签保护不发 POST', async () => {
    reset({ body: statusBody(true) })
    const result = await adapter.checkin(ACCOUNT)
    assert.equal(result.already, true)
    assert.equal(result.confirmed, true)
    assert.equal(result.awardText, '$5.00')
    assert.equal(postCalls(), 0)
  })

  await test('奖励为零时不领取', async () => {
    reset({ body: statusBody(false, 0) })
    const result = await adapter.checkin(ACCOUNT)
    assert.equal(result.ok, false)
    assert.match(result.msg, /暂未开启签到/)
    assert.equal(postCalls(), 0)
  })

  await test('POST 成功：无请求体、Bearer、真实美元结果', async () => {
    reset({ body: statusBody(false) }, opts => {
      assert.equal(opts.headers.Authorization, `Bearer ${TOKEN}`)
      assert.equal(opts.body, null)
      return { body: statusBody(true) }
    })
    const result = await adapter.checkin({ ...ACCOUNT, baseUrl: `${ACCOUNT.baseUrl}/` })
    assert.equal(result.ok, true)
    assert.equal(result.already, false)
    assert.equal(result.confirmed, true)
    assert.equal(result.awardText, '$5.00')
    assert.equal(result.awardQuota, undefined)
    assert.equal(postCalls(), 1)
  })

  await test('POST 无效 token 与业务失败不泄露站点回显', async () => {
    for (const response of [{ status: 401 }, { status: 403 }, { body: { code: 'INVALID_TOKEN', message: TOKEN } }, { body: { code: 1, message: TOKEN } }]) {
      reset({ body: statusBody(false) }, response)
      const result = await adapter.checkin(ACCOUNT)
      assert.equal(result.ok, false)
      assert.ok(!result.msg.includes(TOKEN))
      assert.equal(postCalls(), 1)
    }
  })

  await test('POST 未签/畸形响应只能标为未确认', async () => {
    for (const response of [{ body: statusBody(false) }, { body: { code: 0, data: {} } }, { status: 502, body: null }]) {
      reset({ body: statusBody(false) }, response)
      const result = await adapter.checkin(ACCOUNT)
      assert.equal(result.confirmed, false)
      assert.equal(result.uncertain, true)
      assert.equal(postCalls(), 1)
    }
  })

  await test('执行器完整签到、金额展示与再次运行已签保护', async () => {
    let checked = false
    reset(() => ({ body: statusBody(checked) }), () => { checked = true; return { body: statusBody(true) } })
    const account = { ...ACCOUNT }
    const result = await checkinAccount(account)
    assert.equal(result.status, 'ok')
    assert.equal(result.award, '+$5.00')
    assert.equal(result.balance, '-')
    assert.equal(result.awardQuotaValue, null)
    assert.equal(account.lastCheckinConfirmed, true)
    const again = await checkinAccount(account)
    assert.equal(again.status, 'already')
    assert.equal(again.award, '今日 +$5.00')
    assert.equal(postCalls(), 1)
    assert.ok(calls.every(c => c.endsWith(URL)))
  })

  await test('POST 响应丢失只读复核成功、不重试', async () => {
    let checked = false
    reset(() => ({ body: statusBody(checked) }), () => { checked = true; throw new Error('test POST response lost') })
    const result = await checkinAccount({ ...ACCOUNT })
    assert.equal(result.status, 'ok')
    assert.equal(result.statusText, '状态复核成功')
    assert.equal(result.msg, '')
    assert.equal(result.award, '+$5.00')
    assert.equal(postCalls(), 1)
  })

  await test('POST 未获响应且复核未签，持久状态不误记成功', async () => {
    reset({ body: statusBody(false) }, () => { throw new Error('test POST response lost') })
    const account = { ...ACCOUNT }
    const result = await checkinAccount(account)
    assert.equal(result.status, 'unknown')
    assert.equal(result.award, '')
    assert.equal(account.lastCheckinConfirmed, false)
    assert.equal(account.lastCheckinAt, undefined)
    assert.ok(account.lastCheckinAttemptAt)
    assert.equal(postCalls(), 1)
  })

  await test('执行器遇到无效 token 也不能提交，日志不含凭据', async () => {
    reset({ status: 401, body: { code: 'INVALID_TOKEN', message: TOKEN } })
    const result = await checkinAccount({ ...ACCOUNT })
    assert.equal(result.status, 'fail')
    assert.match(result.msg, /重新登录.*更新 Auth token/)
    assert.equal(postCalls(), 0)
    assert.ok(logs.every(line => !line.includes(TOKEN)))
  })
  console.log(`\napikey.casa ${passed} 组隔离回归全部通过（无真实请求）`)
} catch (err) {
  failed = true
  console.error(err)
} finally {
  global.fetch = realFetch
  // 启动前已拒绝任何现有 data/；这里只清理本测试新建的数据。
  if (fs.existsSync(DATA)) fs.rmSync(DATA, { recursive: true, force: true })
}
process.exit(failed ? 1 : 0)