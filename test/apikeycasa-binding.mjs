/**
 * apikey.casa 绑定入口限制回归：仅假凭据/mock fetch，不登录真实站点、不发送消息。
 * 只能在不含 data/ 的独立副本执行：node test/apikeycasa-binding.mjs。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DATA = path.join(ROOT, 'data')
if (fs.existsSync(DATA)) throw new Error('请在不含 data/ 的独立插件副本运行，不能使用在线目录')
const TOKEN = 'FAKE_HEADER.FAKE_PAYLOAD.FAKE_SIGNATURE'
const SITE = { baseUrl: 'https://apikey.casa', host: 'apikey.casa' }
const USER_URL = `${SITE.baseUrl}/api/v1/auth/me`
const STATE_URL = `${SITE.baseUrl}/api/v1/redeem/checkin`
const logs = []
global.logger = Object.fromEntries(['info', 'mark', 'warn', 'error'].map(k => [k, (...a) => logs.push(a.join(' '))]))
global.Bot = { uin: 10000 }
const realFetch = global.fetch
const calls = []
let routes = {}
global.fetch = async (url, opts = {}) => {
  const key = `${opts.method || 'GET'} ${url}`
  calls.push(key)
  const handler = routes[key]
  assert.ok(handler, `未定义mock路由: ${key}`)
  const r = typeof handler === 'function' ? await handler(opts) : handler
  return { status: r.status ?? 200, text: async () => JSON.stringify(r.body ?? null), headers: { get: () => 'application/json', getSetCookie: () => [] } }
}
function reset() { calls.length = 0; routes = {} }
function validRoutes() {
  routes = {
    [`GET ${USER_URL}`]: { body: { code: 0, data: { id: 7, username: 'test-user', balance: 30 } } },
    [`GET ${STATE_URL}`]: { body: { code: 0, data: { checked_in: true, reward: 5 } } },
    // 即便公开配置长得像Sub2API，Auth token入口也绝不能访问它。
    [`GET ${SITE.baseUrl}/api/v1/settings/public`]: { body: { code: 0, data: { site_name: 'fake-sub2api', registration_enabled: true, turnstile_enabled: false } } }
  }
}
let seq = 5000
let passed = 0
let failed = false
let Core, disposeBinds, getEntry
const cases = []
function createCore(msg = '', isGroup = false, userId = ++seq) {
  const replies = [], recalls = []
  const e = { user_id: userId, self_id: 10000, isGroup, isMaster: false, message_id: 'test-message', sender: { nickname: 'test-user' }, msg, raw_message: msg }
  if (isGroup) { e.group_id = 900; e.group = { recallMsg: async id => recalls.push(id) } }
  const core = new Core({ e, reply: async value => { replies.push(String(value)); return {} } })
  const c = { core, e, replies, recalls }; cases.push(c); return c
}
function setMessage(c, text) { c.e.msg = text; c.e.raw_message = text }
function assertHint(text) {
  assert.match(text, /支持邮箱密码自动登录或 Auth token/)
  assert.match(text, /#中转添加 https:\/\/apikey\.casa AuthToken值/)
  assert.match(text, /F12.*Network.*Authorization/)
}
async function test(name, fn) { await fn(); passed++; console.log(`OK ${name}`) }
try {
  const { installHost } = await import('../host/index.js')
  const { createTrssHost } = await import('../host/trss.js')
  const host = createTrssHost()
  installHost({ ...host, renderTemplate: async () => false })
  const { getConfig } = await import('../models/config.js')
  const cfg = getConfig()
  cfg.proxy = { url: '', hosts: [], useForBrowser: false }
  cfg.security.allowedPrivateHosts = ['apikey.casa', 'sub2guard.test']
  cfg.browser.enable = false
  cfg.request.retry = 0
  cfg.bind.groupRecallSec = 0
  cfg.bind.timeoutSec = 300
  cfg.recallAdd = true
  const coreMod = await import('../apps/checkin.js')
  Core = coreMod.RelayCheckinCore; disposeBinds = coreMod.disposeBinds
  getEntry = (await import('../models/store.js')).getEntry
  const registry = await import('../models/adapters/index.js')
  const policy = await import('../models/apikeycasa-policy.js')
  const { checkinAccountResults, queryEntry, refreshBalances } = await import('../models/executor.js')

  await test('站点识别覆盖端口/FQDN且不误拦其他主机', async () => {
    for (const baseUrl of ['https://apikey.casa', 'https://APIKEY.CASA', 'https://apikey.casa:443', 'https://apikey.casa.']) {
      assert.equal(policy.isApikeyCasaSite({ baseUrl }), true)
      for (const kind of ['cookie', 'refresh']) assertHint(policy.bindingRestrictionForSite({ baseUrl }, kind))
      assert.equal(policy.bindingRestrictionForSite({ baseUrl }, 'token'), null)
      assert.equal(policy.bindingRestrictionForSite({ baseUrl }, 'email'), null)
    }
    for (const baseUrl of ['https://apikey.casa.evil.test', 'https://fake-apikey.casa', 'https://sub2guard.test']) {
      assert.equal(policy.isApikeyCasaSite({ baseUrl }), false)
      assert.equal(policy.bindingRestrictionForSite({ baseUrl }, 'email'), null)
    }
    assert.equal(registry.preferredBindingForHost('apikey.casa:443'), 'token')
  })

  await test('专用站点禁止通用Sub2API/Session探测，无网络请求', async () => {
    reset()
    assert.deepEqual(await registry.probeSub2apiSite(SITE.baseUrl), { ok: false })
    const r = await registry.probeSessionAccount(SITE.baseUrl, 'FAKE_SESSION', 7)
    assert.equal(r.ok, false); assertHint(r.msg)
    assert.deepEqual(calls, [])
  })

  await test('Cookie/刷新令牌入口：两种前缀、群私聊、简写完整参数全部拦截', async () => {
    for (const prefix of ['#中转', '#中转站']) for (const isGroup of [false, true]) {
      for (const [suffix, method, creds] of [['添加cookie', 'addCookie', 'FAKE_COOKIE 7'], ['添加刷新令牌', 'addRefresh', 'rt_FAKE_REFRESH']]) {
        for (const tail of ['', ` ${creds}`]) {
          reset()
          const c = createCore(`${prefix}${suffix} ${SITE.baseUrl}${tail}`, isGroup)
          assert.equal(await c.core[method](), true)
          assertHint(c.replies.at(-1))
          assert.equal(c.recalls.length, isGroup && tail ? 1 : 0)
          assert.ok(!c.replies.join('\n').includes('正在登录'))
          assert.equal(getEntry(c.e), null)
          assert.deepEqual(calls, [])
        }
      }
    }
  })

  await test('底层验证函数直接调用也禁止Cookie/refresh登录', async () => {
    const c = createCore()
    const probe = { ok: true, siteName: 'fake' }
    reset()
    for (const fn of [
      () => c.core.verifyCookie(SITE, 'FAKE_COOKIE', 7),
      () => c.core.verifySub2apiRefresh(SITE, 'rt_FAKE_REFRESH', probe)
    ]) { const r = await fn(); assert.equal(r.ok, false); assertHint(r.msg) }
    assert.deepEqual(calls, [])
    assert.equal(getEntry(c.e), null)
  })

  await test('错误绑定不建立私聊会话，旧会话消费前也拦截', async () => {
    for (const kind of ['cookie', 'refresh']) {
      reset()
      const c = createCore()
      await c.core.startBind(kind, SITE)
      assertHint(c.replies.at(-1))
      setMessage(c, '中转绑定 FAKE_INPUT')
      await c.core.bindCredentials()
      assert.match(c.replies.at(-1), /当前没有等待绑定/)
      // 模拟旧版本留下的pendingBinds，不在生产代码添加测试后门。
      const reject = c.core.rejectUnsupportedBinding
      c.core.rejectUnsupportedBinding = async () => false
      await c.core.startBind(kind, SITE)
      c.core.rejectUnsupportedBinding = reject
      setMessage(c, '中转绑定 FAKE_INPUT')
      await c.core.bindCredentials()
      assertHint(c.replies.at(-1))
      await c.core.bindCredentials()
      assert.match(c.replies.at(-1), /当前没有等待绑定/)
      assert.equal(getEntry(c.e), null)
      assert.deepEqual(calls, [])
    }
  })

  await test('API Key、Cookie串、refresh、邮箱及带Bearer前缀不能冒充Auth token', async () => {
    const c = createCore()
    for (const value of ['sk_FAKE_KEY', 'rt_FAKE_REFRESH', 'auth_token=FAKE_COOKIE', 'session=FAKE_COOKIE', 'user@example.test', `Bearer ${TOKEN}`, '', 'fake', null]) {
      reset()
      const r = await registry.probeAccount(SITE.baseUrl, value, null)
      assert.equal(r.ok, false); assertHint(r.msg)
      assert.deepEqual(calls, [])
    }
    for (const value of ['sk_FAKE_KEY']) {
      reset(); setMessage(c, `#中转添加 ${SITE.baseUrl} ${value}`)
      await c.core.add()
      assertHint(c.replies.at(-1))
      assert.equal(getEntry(c.e), null)
      assert.deepEqual(calls, [])
    }
  })

  await test('JWT外形只是预检，失效的Auth token必须经服务端拒绝且不入库', async () => {
    reset()
    routes = { [`GET ${USER_URL}`]: { status: 401, body: { code: 'INVALID_TOKEN', message: TOKEN } } }
    const c = createCore(`#中转添加 ${SITE.baseUrl} ${TOKEN}`)
    await c.core.add()
    assert.match(c.replies.at(-1), /重新登录.*更新 Auth token/)
    assert.ok(!c.replies.join('\n').includes(TOKEN))
    assert.equal(getEntry(c.e), null)
    assert.deepEqual(calls, [`GET ${USER_URL}`])
  })

  await test('普通用户有效Auth token直接添加，跳过Sub2API公开配置', async () => {
    for (const prefix of ['#中转', '#中转站']) for (const isGroup of [false, true]) {
      reset(); validRoutes()
      const c = createCore(`${prefix}添加 ${SITE.baseUrl} ${TOKEN}`, isGroup)
      assert.equal(await c.core.add(), true)
      const entry = getEntry(c.e)
      assert.equal(entry.accounts.length, 1)
      assert.equal(entry.accounts[0].type, 'apikeycasa')
      assert.equal(entry.accounts[0].authMode, 'token')
      assert.equal(entry.accounts[0].siteUserId, 7)
      assert.equal(entry.accounts[0].lastBalance, '$30.00')
      assert.equal(entry.accounts[0].lastCheckinConfirmed, true)
      assert.ok(calls.every(key => key===`GET ${USER_URL}` || key===`GET ${STATE_URL}`))
      assert.equal(c.recalls.length, isGroup ? 1 : 0)
    }
  })

  await test('显式开启手动token会话仍可补发token绑定', async () => {
    reset(); validRoutes()
    const c = createCore(`#中转添加 ${SITE.baseUrl}`)
    await c.core.startBind('token', SITE)
    assert.match(c.replies.at(-1), /Auth token.*F12.*Network.*Bearer/)
    assert.ok(!c.replies.at(-1).includes('Veloera'))
    assert.deepEqual(calls, [])
    setMessage(c, `中转绑定 ${TOKEN}`)
    await c.core.bindCredentials()
    const entry = getEntry(c.e)
    assert.equal(entry.accounts.length, 1)
    assert.equal(entry.accounts[0].type, 'apikeycasa')
    assert.ok(calls.every(key => key===`GET ${USER_URL}` || key===`GET ${STATE_URL}`))
  })

  await test('有效token按站点ID更新旧邮箱误绑，不新增账号、不再保存密码', async () => {
    reset(); validRoutes()
    const c = createCore(`#中转添加 ${SITE.baseUrl} ${TOKEN}`)
    const { upsertAccount } = await import('../models/store.js')
    upsertAccount(c.e, { name: 'apikey.casa', baseUrl: SITE.baseUrl, type: 'sub2api', authMode: 'email', loginEmail: 'fake@example.test', password: 'FAKE_PASSWORD', token: 'rt_FAKE_REFRESH', accessToken: 'FAKE_ACCESS', siteUserId: 7, auto: false })
    await c.core.add()
    const entry = getEntry(c.e)
    assert.equal(entry.accounts.length, 1)
    assert.equal(entry.accounts[0].type, 'apikeycasa')
    assert.equal(entry.accounts[0].authMode, 'token')
    assert.equal(entry.accounts[0].loginEmail, null)
    assert.equal(entry.accounts[0].password, null)
    assert.equal(entry.accounts[0].accessToken, null)
    assert.equal(entry.accounts[0].tokenExpiresAt, null)
    assert.equal(entry.accounts[0].auto, false)
    assert.ok(calls.every(key => key===`GET ${USER_URL}` || key===`GET ${STATE_URL}`))
  })

  await test('旧错误类型签到/查询/列表刷新不登录、不发请求、不改变原凭据', async () => {
    for (const [type,authMode] of [['sub2api','email'],['sub2api','refresh'],['generic','cookie'],['newapi','token']]) {
      const account = { name: 'apikey.casa', baseUrl: SITE.baseUrl, type, authMode, token: TOKEN, accessToken: 'FAKE_ACCESS', password: 'FAKE_PASSWORD', lastBalance: '$9.00' }
      const before = { ...account }
      reset()
      const rows = await checkinAccountResults(account)
      assert.equal(rows[0].status, 'fail'); assertHint(rows[0].msg)
      const query = await queryEntry({ accounts: [account] })
      assert.equal(query[0].status, 'fail'); assertHint(query[0].msg)
      await refreshBalances({ accounts: [account] })
      assert.deepEqual(calls, [])
      assert.equal(account.token, before.token)
      assert.equal(account.password, before.password)
      assert.equal(account.lastBalance, before.lastBalance)
    }
  })

  await test('其他Sub2API站点仍可探测，其他绑定偏好不变', async () => {
    reset()
    routes = { 'GET https://sub2guard.test/api/v1/settings/public': { body: { code: 0, data: { site_name: 'normal', registration_enabled: true, turnstile_enabled: false } } } }
    assert.equal((await registry.probeSub2apiSite('https://sub2guard.test')).ok, true)
    assert.equal(registry.preferredBindingForHost('agentrouter.org'), 'email')
    assert.equal(registry.preferredBindingForHost('anyrouter.top'), 'cookie')
    assert.equal(registry.preferredBindingForHost('up.x666.me'), 'cookie')
    assert.equal(registry.getAccountAdapter({ baseUrl:'https://sub2guard.test',type:'sub2api' }).type, 'sub2api')
  })

  assert.ok(logs.every(line => !line.includes(TOKEN) && !line.includes('FAKE_PASSWORD')))
  console.log(`\napikey.casa 绑定限制 ${passed} 组回归全部通过（无真实请求）`)
} catch (err) { failed = true; console.error(err) }
finally {
  disposeBinds?.()
  global.fetch = realFetch
  if (fs.existsSync(DATA)) fs.rmSync(DATA, { recursive: true, force: true })
}
process.exit(failed ? 1 : 0)