/** 仅在不含 data/ 的隔离副本执行；所有请求和凭据都是模拟值。 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DATA = path.join(ROOT, 'data')
if (fs.existsSync(DATA)) throw new Error('禁止在含 data/ 的在线副本运行')
const BASE = 'https://apikey.casa'
const SITE = { baseUrl: BASE, host: 'apikey.casa' }
const ACCESS = 'FAKE_HEADER.FAKE_PAYLOAD.FAKE_SIGNATURE'
const PASSWORD = 'FAKE_SECRET_PASSWORD'
const REFRESH = 'rt_FAKE_REFRESH'
const logs = []
global.logger = Object.fromEntries(['info','mark','warn','error'].map(k => [k, (...a) => logs.push(a.join(' '))]))
global.Bot = { uin: 10000 }
const realFetch = global.fetch
let routes = {}, calls = [], passed = 0, failed = false, disposeBinds
const ok = data => ({ body: { code: 0, data } })
const tokens = (suffix = '') => ({ access_token: ACCESS + suffix, refresh_token: REFRESH + suffix, expires_in: 86400, user: { id: 7 } })
function defaults() {
  calls = []
  routes = {
    'GET /settings/public': ok({ turnstile_enabled: false, tencent_captcha_enabled: false, aliyun_captcha_enabled: false }),
    'POST /auth/login': opts => {
      assert.deepEqual(JSON.parse(opts.body), { email: 'fake@example.test', password: PASSWORD })
      return ok(tokens())
    },
    'POST /auth/refresh': ok(tokens('_NEW')),
    'GET /auth/me': ok({ id: 7, username: 'fake', balance: 30 }),
    'GET /redeem/checkin': ok({ checked_in: true, reward: 5 }),
    'POST /redeem/checkin': ok({ checked_in: true, reward: 5 })
  }
}
global.fetch = async (url, opts = {}) => {
  assert.ok(String(url).startsWith(BASE + '/api/v1/'))
  const key = (opts.method || 'GET') + ' ' + String(url).slice((BASE + '/api/v1').length)
  calls.push(key)
  assert.ok(routes[key], '未定义模拟路由: ' + key)
  const r = typeof routes[key] === 'function' ? await routes[key](opts) : routes[key]
  return { status: r.status ?? 200, text: async () => JSON.stringify(r.body), headers: { get: () => 'application/json', getSetCookie: () => [] } }
}
const account = extra => ({ name: 'apikey.casa', baseUrl: BASE, type: 'apikeycasa', authMode: 'email', loginEmail: 'fake@example.test', password: PASSWORD, token: '', accessToken: '', tokenExpiresAt: null, siteUserId: 7, ...extra })
async function test(name, fn) { defaults(); await fn(); passed++; console.log('OK ' + name) }
let seq = 9000
try {
  const { installHost } = await import('../host/index.js')
  const { createTrssHost } = await import('../host/trss.js')
  installHost({ ...createTrssHost(), renderTemplate: async () => false })
  const { getConfig } = await import('../models/config.js')
  const cfg = getConfig()
  cfg.proxy = { url: '', hosts: [], useForBrowser: false }
  cfg.security.allowedPrivateHosts = ['apikey.casa']
  cfg.browser.enable = false
  cfg.request.retry = 0
  cfg.bind.groupRecallSec = 0
  cfg.bind.timeoutSec = 300
  cfg.recallAdd = true
  const { default: adapter } = await import('../models/adapters/apikeycasa.js')
  const { ensureCasaToken } = await import('../models/apikeycasa-auth.js')
  const { upsertAccount, getEntry } = await import('../models/store.js')
  const { RelayCheckinCore, disposeBinds: dispose } = await import('../apps/checkin.js')
  disposeBinds = dispose
  function core(msg = '', isGroup = false) {
    const replies = [], recalls = []
    const e = { user_id: ++seq, self_id: 10000, isGroup, isMaster: false, message_id: 'fake', sender: { nickname: 'fake' }, msg, raw_message: msg }
    if (isGroup) { e.group_id = 900; e.group = { recallMsg: async id => recalls.push(id) } }
    return { e, replies, recalls, c: new RelayCheckinCore({ e, reply: async text => { replies.push(String(text)); return {} } }) }
  }
  await test('邮箱登录后余额和签到状态只走 casa 专用接口', async () => {
    const a = account()
    assert.equal((await adapter.userInfo(a)).balanceText, '$30.00')
    assert.equal(a.accessToken, ACCESS); assert.equal(a.token, REFRESH)
    assert.equal((await adapter.checkin(a)).already, true)
    assert.equal(calls.filter(x => x === 'POST /auth/login').length, 1)
    assert.ok(!calls.includes('POST /redeem/checkin'))
  })
  await test('未过期凭据直接查询，无登录和刷新', async () => {
    const a = account({ accessToken: ACCESS, token: REFRESH, tokenExpiresAt: Date.now() + 86400000 })
    assert.equal((await adapter.getCheckinStatus(a)).ok, true)
    assert.deepEqual(calls, ['GET /redeem/checkin'])
  })
  await test('过期优先刷新，轮换凭据立即落盘', async () => {
    const c = core()
    const a = upsertAccount(c.e, account({ token: REFRESH, accessToken: ACCESS, tokenExpiresAt: 1 })).account
    assert.equal((await adapter.userInfo(a)).ok, true)
    assert.deepEqual(calls, ['POST /auth/refresh', 'GET /auth/me'])
    const stored = JSON.parse(fs.readFileSync(path.join(DATA, 'accounts.json')))[String('u:' + c.e.user_id)].accounts[0]
    assert.equal(stored.token, REFRESH + '_NEW'); assert.equal(stored.accessToken, ACCESS + '_NEW')
    assert.ok(stored.tokenExpiresAt > Date.now())
  })
  await test('多个并发请求仅刷新一次', async () => {
    const a = account({ token: REFRESH })
    routes['POST /auth/refresh'] = async () => { await new Promise(r => setTimeout(r, 20)); return ok(tokens('_NEW')) }
    const results = await Promise.all([adapter.userInfo(a), adapter.getCheckinStatus(a), ensureCasaToken(a)])
    assert.ok(results.every(r => r.ok))
    assert.equal(calls.filter(x => x === 'POST /auth/refresh').length, 1)
  })
  await test('只读401后刷新重试一次', async () => {
    const a = account({ token: REFRESH, accessToken: ACCESS, tokenExpiresAt: Date.now() + 86400000 })
    routes['GET /auth/me'] = opts => opts.headers.Authorization === 'Bearer ' + ACCESS
      ? { status: 401, body: { code: 'UNAUTHORIZED' } } : ok({ id: 7, balance: 30 })
    assert.equal((await adapter.userInfo(a)).ok, true)
    assert.deepEqual(calls, ['GET /auth/me', 'POST /auth/refresh', 'GET /auth/me'])
  })
  await test('旧请求的401遇到已更新token不重复刷新', async () => {
    const a = account({ token: REFRESH, accessToken: ACCESS + '_NEW', tokenExpiresAt: Date.now() + 86400000 })
    assert.equal((await ensureCasaToken(a, { failedToken: ACCESS })).token, ACCESS + '_NEW')
    assert.deepEqual(calls, [])
  })
  await test('刷新明确失效才回退邮箱密码', async () => {
    routes['POST /auth/refresh'] = { status: 401, body: { code: 'INVALID_TOKEN' } }
    assert.equal((await adapter.login(account({ token: REFRESH }))).ok, true)
    assert.deepEqual(calls, ['POST /auth/refresh', 'GET /settings/public', 'POST /auth/login'])
  })
  await test('刷新网络失败、限流和服务异常不重复密码登录', async () => {
    for (const status of [429, 500, 503]) {
      defaults(); routes['POST /auth/refresh'] = { status, body: { code: status, message: PASSWORD } }
      const r = await adapter.login(account({ token: REFRESH }))
      assert.equal(r.ok, false); assert.ok(!r.msg.includes(PASSWORD))
      assert.deepEqual(calls, ['POST /auth/refresh'])
    }
    defaults(); routes['POST /auth/refresh'] = () => { throw new Error(PASSWORD) }
    assert.equal((await adapter.userInfo(account({ token: REFRESH }))).ok, false)
    assert.deepEqual(calls, ['POST /auth/refresh'])
  })
  await test('密码错误提示脱敏且不循环登录', async () => {
    routes['POST /auth/login'] = { status: 401, body: { code: 401, message: PASSWORD } }
    const r = await adapter.login(account())
    assert.equal(r.ok, false); assert.match(r.msg, /检查邮箱和密码/); assert.ok(!r.msg.includes(PASSWORD))
    assert.equal(calls.filter(x => x === 'POST /auth/login').length, 1)
  })
  await test('验证码开启不发送密码，配置缺失不猜测', async () => {
    for (const key of ['turnstile_enabled','tencent_captcha_enabled','aliyun_captcha_enabled']) {
      defaults(); routes['GET /settings/public'] = ok({ turnstile_enabled: false, [key]: true })
      const r = await adapter.login(account()); assert.equal(r.ok, false); assert.match(r.msg, /验证码/)
      assert.deepEqual(calls, ['GET /settings/public'])
    }
    defaults(); routes['GET /settings/public'] = ok({})
    assert.equal((await adapter.login(account())).ok, false)
    assert.deepEqual(calls, ['GET /settings/public'])
  })
  await test('2FA及不完整凭据不能当登录成功', async () => {
    routes['POST /auth/login'] = ok({ requires_2fa: true, temp_token: PASSWORD })
    const r = await adapter.login(account()); assert.equal(r.ok, false); assert.match(r.msg, /二次验证/)
    for (const key of ['access_token','refresh_token','expires_in']) {
      defaults(); const t = tokens(); delete t[key]; routes['POST /auth/login'] = ok(t)
      assert.equal((await adapter.login(account())).ok, false)
    }
  })
  await test('拒绝不一致用户ID，不覆盖原令牌', async () => {
    const a = account({ token: REFRESH })
    routes['POST /auth/refresh'] = ok({ ...tokens(), user: { id: 8 } })
    const r = await adapter.login(a); assert.equal(r.ok, false); assert.match(r.msg, /不一致/)
    assert.equal(a.token, REFRESH)
  })
  await test('邮箱登录后真实执行链模拟领取并只提交一次', async () => {
    const { checkinAccountResults } = await import('../models/executor.js')
    let checked = false
    routes['GET /redeem/checkin'] = () => ok({ checked_in: checked, reward: 5 })
    routes['POST /redeem/checkin'] = opts => {
      assert.equal(opts.headers.Authorization, 'Bearer ' + ACCESS)
      checked = true; return ok({ checked_in: true, reward: 5 })
    }
    const a = account()
    const rows = await checkinAccountResults(a)
    assert.equal(rows[0].status, 'ok')
    assert.equal(rows[0].award, '+$5.00')
    await checkinAccountResults(a)
    assert.equal(calls.filter(x => x === 'POST /redeem/checkin').length, 1)
  })
  await test('凭据保存失败报告失败，不继续查询签到', async () => {
    const c = core()
    const a = upsertAccount(c.e, account({ token: REFRESH })).account
    const original = fs.writeFileSync
    fs.writeFileSync = () => { throw new Error('disk full') }
    try {
      const r = await adapter.getCheckinStatus(a)
      assert.equal(r.ok, false); assert.match(r.msg, /保存失败/)
      assert.deepEqual(calls, ['POST /auth/refresh'])
    } finally { fs.writeFileSync = original }
  })
  await test('签到POST不带body且鉴权失败不重发', async () => {
    routes['GET /redeem/checkin'] = ok({ checked_in: false, reward: 5 })
    routes['POST /redeem/checkin'] = opts => {
      assert.equal(opts.body, null); assert.equal(opts.headers.Authorization, 'Bearer ' + ACCESS)
      return { status: 401, body: { code: 'UNAUTHORIZED' } }
    }
    assert.equal((await adapter.checkin(account())).ok, false)
    assert.equal(calls.filter(x => x === 'POST /redeem/checkin').length, 1)
    assert.ok(!calls.includes('POST /auth/refresh'))
  })
  await test('签到响应丢失不重复领取', async () => {
    routes['GET /redeem/checkin'] = ok({ checked_in: false, reward: 5 })
    routes['POST /redeem/checkin'] = () => { throw new Error('network') }
    assert.equal((await adapter.checkin(account())).uncertain, true)
    assert.equal(calls.filter(x => x === 'POST /redeem/checkin').length, 1)
  })
  await test('两种前缀群私聊完整邮箱绑定均保存专用类型', async () => {
    for (const prefix of ['#中转','#中转站']) for (const group of [true,false]) {
      defaults(); const c = core(prefix + '添加邮箱 apikey.casa fake@example.test ' + PASSWORD, group)
      await c.c.addEmail()
      const a = getEntry(c.e)?.accounts[0]
      assert.ok(a, c.replies.join('\n')); assert.equal(a.type, 'apikeycasa'); assert.equal(a.authMode, 'email')
      assert.equal(a.token, REFRESH); assert.equal(a.siteUserId, 7)
      assert.equal(c.recalls.length, group ? 1 : 0)
    }
  })
  await test('分步私聊补发邮箱密码，提示给正确邮箱指令', async () => {
    const c = core('#中转添加邮箱 apikey.casa')
    await c.c.addEmail()
    assert.match(c.replies.join('\n'), /邮箱 登录密码/)
    assert.ok(!c.replies.join('\n').includes('Auth token'))
    c.e.msg = c.e.raw_message = '中转绑定 fake@example.test ' + PASSWORD
    await c.c.bindCredentials()
    assert.equal(getEntry(c.e)?.accounts[0]?.authMode, 'email')
  })
  await test('底层邮箱入口均走专用适配器', async () => {
    const c = core()
    for (const method of ['verifyEmail','verifySub2apiEmail','verifyAgentRouterEmail']) {
      defaults(); const r = await c.c[method](SITE, 'fake@example.test', PASSWORD, { ok: true })
      assert.equal(r.ok, true); assert.equal(r.account.type, 'apikeycasa')
    }
  })
  await test('同ID邮箱重绑覆盖旧token，保留自动签到开关', async () => {
    const c = core('#中转添加邮箱 apikey.casa fake@example.test ' + PASSWORD)
    upsertAccount(c.e, { ...account(), authMode: 'token', token: ACCESS, loginEmail: null, password: null, auto: false })
    await c.c.addEmail()
    const entry = getEntry(c.e)
    assert.equal(entry.accounts.length, 1); assert.equal(entry.accounts[0].authMode, 'email')
    assert.equal(entry.accounts[0].auto, false)
  })
  await test('错误密码绑定不入库且不泄漏凭据', async () => {
    routes['POST /auth/login'] = { status: 401, body: { code: 401, message: PASSWORD } }
    const c = core('#中转添加邮箱 apikey.casa fake@example.test ' + PASSWORD)
    await c.c.addEmail(); assert.equal(getEntry(c.e), null)
    assert.ok(!c.replies.join('\n').includes(PASSWORD))
  })
  assert.ok(logs.every(s => !s.includes(PASSWORD) && !s.includes(REFRESH) && !s.includes(ACCESS)))
  console.log('\napikey.casa 邮箱登录 ' + passed + ' 组隔离回归通过，无真实请求')
} catch (err) { failed = true; console.error(err) }
finally { disposeBinds?.(); global.fetch = realFetch; if (fs.existsSync(DATA)) fs.rmSync(DATA, { recursive: true, force: true }) }
process.exit(failed ? 1 : 0)
