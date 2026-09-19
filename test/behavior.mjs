/**
 * 行为测试：mock fetch 验证适配器签到链路 + art-template 渲染模板
 * 运行：node test/behavior.mjs（在插件根目录，需 npm i --no-save yaml chokidar art-template）
 */
import assert from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

global.logger = { info: () => {}, mark: () => {}, warn: () => {}, error: (...a) => console.error('[logger.error]', ...a) }
global.Bot = { uin: 10000 }

// ---- 装上 TRSS 宿主适配层（业务代码通过它取 logger / 数据目录 / 配置 / 出图）----
const { installHost } = await import('../host/index.js')
const { createTrssHost } = await import('../host/trss.js')
installHost(createTrssHost())

const DATA = path.join(ROOT, 'data')
const hadData = fs.existsSync(DATA)
const backup = path.join(ROOT, 'data_backup_behavior')
if (hadData) fs.renameSync(DATA, backup)

// ---- mock fetch：按 (method, url) 路由 ----
let routes = {}
const realFetch = global.fetch
const networkCalls = []
global.fetch = async (url, opts = {}) => {
  const key = `${opts.method || 'GET'} ${url}`
  networkCalls.push(key)
  const handler = routes[key]
  if (!handler) throw new Error(`mock fetch 未定义路由: ${key}`)
  const { status = 200, body = null, capture, setCookies = [] } = typeof handler === 'function' ? handler(opts) : handler
  if (capture) capture(opts)
  return {
    status,
    json: async () => {
      if (body === null) throw new Error('no json')
      return body
    },
    headers: {
      get: name => String(name).toLowerCase() === 'set-cookie' ? (setCookies[0] || null) : null,
      getSetCookie: () => setCookies
    }
  }
}

try {
  // 行为测试使用 mock fetch，不应依赖测试域名的真实 DNS；显式信任这些测试目标。
  const cfgMod = await import('../models/config.js')
  const cfgNow = cfgMod.getConfig()
  cfgNow.security.allowedPrivateHosts = [
    'agentrouter.org', 'newapi.test', 'n.com', 'v.com', 'x.com', 't.com', 'anyrouter.top', 's2.test', 's2v2.test',
    'nocap.test', 'nocap2.test', 'hascap.test', 'badcfg.test', 'flaky.test',
    'tbe.test', 'tbedone.test', 'tbenowait.test'
  ]
  // 同理，测试也不能受运行环境（data/config.yaml 或 config_default 模板）里的代理配置影响：
  // 命中 proxy.hosts 的站点会走 node:https + proxy agent，完全绕过上面的 mock fetch
  // 打到真实站点上，测试便会以站点的真实响应失败。
  cfgNow.proxy = { url: '', hosts: [], useForBrowser: false }
  const agentrouter = (await import('../models/adapters/agentrouter.js')).default
  const { probeAccount } = await import('../models/adapters/index.js')
  const { checkinAccount, checkinEntry, refreshBalances } = await import('../models/executor.js')
  const { request } = await import('../models/adapters/common.js')
  const now = new Date()
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  const today = `${month}-${String(now.getDate()).padStart(2, '0')}`

  const AR = { name: 'agentrouter.org', baseUrl: 'https://agentrouter.org', type: 'agentrouter', token: 'S', siteUserId: 7 }
  const EMAIL_AR = {
    ...AR,
    authMode: 'email',
    loginEmail: 'user@example.com',
    password: 'agentrouter-site-password'
  }

  // ---- 1. AgentRouter：邮箱 + 站内密码重新登录，更新 Session 并确认 $25 ----
  let loginCalls = 0
  let loginBody = null
  let loginCookieHeader = null
  routes = {
    'POST https://agentrouter.org/api/user/login?turnstile=': opts => {
      loginCalls++
      loginBody = JSON.parse(opts.body)
      loginCookieHeader = opts.headers.Cookie
      return {
        status: 200,
        // 真实 AgentRouter 登录响应可能返回 quota=0 占位值，不能用于结果图余额。
        body: { success: true, data: { id: 7, username: 'u', checked_in: true, quota: 0, used_quota: 0 } },
        setCookies: ['session=NEW_SESSION; Path=/; HttpOnly']
      }
    },
    'GET https://agentrouter.org/api/status': {
      status: 200,
      body: {
        success: true,
        data: { quota_per_unit: 500000, announcements: [{ content: '支持登录签到；签到送 $25 Credit' }] }
      }
    }
  }
  let emailAccount = { ...EMAIL_AR }
  let r = await agentrouter.checkin(emailAccount)
  // 该站登录响应恒报 checked_in=true，适配器因此只声明「要用余额复核」，
  // 并把公告里的名义奖励放进 awardQuotaFallback，不再直接当成本次到账
  assert.deepEqual(
    [r.ok, r.already, r.verifyByBalance, r.awardQuota, r.awardQuotaFallback],
    [true, false, true, undefined, 12500000]
  )
  assert.deepEqual(loginBody, { username: 'user@example.com', password: 'agentrouter-site-password' })
  assert.equal(loginCookieHeader, undefined, '重新登录请求不得携带旧 Session')
  assert.equal(emailAccount.token, 'NEW_SESSION', '应保存登录响应的新 Session')
  assert.equal(loginCalls, 1, '登录 POST 必须只发送一次')

  // executor 组合：签到前后余额复核，结果明确显示本次 +$25.00。
  let selfCalls = 0
  const selfCookies = []
  routes['GET https://agentrouter.org/api/user/self'] = opts => {
    selfCalls++
    selfCookies.push(opts.headers.Cookie)
    return {
      status: 200,
      body: { success: true, data: { id: 7, quota: selfCalls === 1 ? 5000000 : 16000000, used_quota: 0 } }
    }
  }
  emailAccount = { ...EMAIL_AR }
  const emailResult = await checkinAccount(emailAccount)
  assert.equal(emailResult.status, 'ok')
  assert.equal(emailResult.statusText, '邮箱登录签到成功')
  assert.equal(emailResult.award, '+$22.00', '奖励应为签到前后的实测差额，而不是公告里的 $25')
  assert.equal(emailResult.balance, '$32.00')
  assert.equal(selfCalls, 2, '邮箱登录后必须用新 Session 再查询一次真实余额')
  assert.deepEqual(selfCookies, ['session=S', 'session=NEW_SESSION'])

  // 同一天重复执行：站点照样回 checked_in=true，但余额一分没涨。
  // 这时必须按今日已签展示，否则会把同一笔奖励反复报一遍。
  selfCalls = 0
  routes['GET https://agentrouter.org/api/user/self'] = {
    status: 200,
    body: { success: true, data: { id: 7, quota: 16000000, used_quota: 0 } }
  }
  const emailRepeat = await checkinAccount({ ...EMAIL_AR })
  assert.equal(emailRepeat.status, 'already', '余额未变说明今天已经签过')
  assert.equal(emailRepeat.statusText, '今日已签（余额未变）')
  assert.equal(emailRepeat.award, '', '重复执行不得再报一次奖励')
  assert.equal(emailRepeat.balance, '$32.00')

  // 查不到前后余额时无法判断，退回公告里的名义奖励，保持原有可用性
  delete routes['GET https://agentrouter.org/api/user/self']
  const emailNoInfo = await checkinAccount({ ...EMAIL_AR })
  assert.equal(emailNoInfo.status, 'ok')
  assert.equal(emailNoInfo.award, '+$25.00', '无法比对余额时退回公告名义值')

  // checked_in=false 表示本次登录未新增，按今日已签展示。
  routes = {
    'POST https://agentrouter.org/api/user/login?turnstile=': {
      status: 200,
      body: { success: true, data: { id: 7, username: 'u', checked_in: false, quota: 17500000, used_quota: 0 } },
      setCookies: ['session=NEXT_SESSION; Path=/; HttpOnly']
    }
  }
  r = await agentrouter.checkin({ ...EMAIL_AR })
  assert.equal(r.ok, true)
  assert.equal(r.already, true)
  assert.equal(r.statusTextOverride, '今日已签（登录复核）')

  routes = {
    'POST https://agentrouter.org/api/user/login?turnstile=': {
      status: 200,
      body: { success: false, message: '用户名或密码错误，或用户已被封禁' }
    }
  }
  r = await agentrouter.checkin({ ...EMAIL_AR })
  assert.equal(r.ok, false)
  assert.match(r.msg, /用户名或密码错误/)

  // 登录响应在奖励到账后丢失：POST 不重试，用原 Session 的余额差确认。
  loginCalls = 0
  selfCalls = 0
  routes = {
    'POST https://agentrouter.org/api/user/login?turnstile=': () => {
      loginCalls++
      throw new Error('connection reset after login')
    },
    'GET https://agentrouter.org/api/user/self': () => {
      selfCalls++
      return {
        status: 200,
        body: { success: true, data: { id: 7, quota: selfCalls === 1 ? 5000000 : 17500000, used_quota: 0 } }
      }
    }
  }
  const balanceReconciled = await checkinAccount({ ...EMAIL_AR })
  assert.equal(loginCalls, 1, '登录 POST 响应丢失后不得自动重试')
  assert.equal(balanceReconciled.status, 'ok')
  assert.equal(balanceReconciled.statusText, '余额复核成功')
  assert.equal(balanceReconciled.award, '+$25.00')

  // ---- 2. AgentRouter：Cookie 只能验证 Session，不能冒充重新登录签到 ----
  routes = {
    'GET https://agentrouter.org/api/user/self': { status: 200, body: { success: true, data: { id: 7, username: 'u', quota: 5000000, used_quota: 0 } } }
  }
  r = await agentrouter.checkin(AR)
  assert.equal(r.ok, true)
  assert.equal(r.confirmed, false)
  assert.equal(r.statusTextOverride, 'Session 有效·未重登')
  assert.equal(r.balanceText, '$10.00')

  selfCalls = 0
  routes = {
    'GET https://agentrouter.org/api/user/self': () => { selfCalls++; return { status: 200, body: { success: true, data: { id: 7, quota: 5000000, used_quota: 0 } } } }
  }
  const res = await checkinAccount(AR)
  assert.equal(res.status, 'unknown')
  assert.equal(res.statusText, 'Session 有效·未重登')
  assert.match(res.msg, /无法确认/)
  assert.equal(res.balance, '$10.00')
  assert.equal(selfCalls, 1, 'Session 验证后不应重复查询用户信息')
  assert.equal(AR.lastBalance, '$10.00', '签到后应缓存余额供列表展示')
  assert.equal(AR.lastCheckinConfirmed, false, '仅 Session 有效不得写成已确认签到')
  assert.ok(AR.lastCheckinAttemptAt)

  // ---- 2. AgentRouter：Session 失效 ----
  routes = {
    'GET https://agentrouter.org/api/user/self': { status: 401, body: { success: false, message: '无权进行此操作，未登录且未提供 access token' } }
  }
  r = await agentrouter.checkin(AR)
  assert.equal(r.ok, false)

  // ---- 3.4 NewAPI 网页完整性标记：明确拒绝后补齐 X-Game-* 头安全重试 ----
  const newapiAdapter = (await import('../models/adapters/newapi.js')).default
  let integrityCalls = 0
  let integrityHeaders = null
  routes = {
    'POST https://newapi.test/api/user/checkin': opts => {
      integrityCalls++
      if (integrityCalls === 1) {
        return { status: 200, body: { success: false, message: '游戏动作缺少完整性标记，请刷新页面后重试' } }
      }
      integrityHeaders = opts.headers
      return { status: 200, body: { success: true, message: '签到成功', data: { quota_awarded: 250000 } } }
    }
  }
  const integrityRetried = await newapiAdapter.checkin({
    name: 'newapi.test', baseUrl: 'https://newapi.test', type: 'newapi', token: 't', siteUserId: 1
  })
  assert.equal(integrityRetried.ok, true)
  assert.equal(integrityCalls, 2, '只有服务端明确拒绝完整性标记时才允许重发 POST')
  for (const key of [
    'X-Game-Action-Id', 'X-Game-Client-Ts', 'X-Game-Session-Id',
    'X-Game-Client-Seq', 'X-Game-Client-Fingerprint', 'X-Game-Body-SHA256'
  ]) assert.ok(integrityHeaders[key], `完整性重试应携带 ${key}`)
  assert.equal(integrityHeaders['X-Game-Body-SHA256'], 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')

  // 完整性重试仍失败时保留站点原始原因，不能误报成缺少 Turnstile site key。
  routes = {
    'POST https://newapi.test/api/user/checkin': {
      status: 200,
      body: { success: false, message: '游戏动作缺少完整性标记，请刷新页面后重试' }
    },
    'GET https://newapi.test/api/user/self': {
      status: 200,
      body: { success: true, data: { id: 1, quota: 500000, used_quota: 0 } }
    }
  }
  const integrityFailed = await checkinAccount({ name: 'newapi.test', baseUrl: 'https://newapi.test', type: 'newapi', token: 't' })
  assert.equal(integrityFailed.status, 'fail')
  assert.match(integrityFailed.msg, /完整性标记/)
  assert.doesNotMatch(integrityFailed.msg, /site key/i)
  assert.equal(integrityFailed.balance, '$1.00', '签到失败也应查询余额')


  // ---- 3.5 checkinEntry autoOnly：定时任务只签单账号开关打开的 ----
  routes = {
    'GET https://agentrouter.org/api/user/self': { status: 200, body: { success: true, data: { id: 7, quota: 5000000, used_quota: 0 } } }
  }
  const entryAuto = { accounts: [{ ...AR }, { ...AR, name: 'off.org', auto: false }] }
  const autoRes = await checkinEntry(entryAuto, { autoOnly: true })
  assert.equal(autoRes.length, 1, 'autoOnly 应跳过关闭定时的账号')
  const manualRes = await checkinEntry(entryAuto, {})
  assert.equal(manualRes.length, 2, '手动签到不受单账号定时开关影响')
  const singleRes = await checkinEntry(entryAuto, { index: 2 })
  assert.equal(singleRes.length, 1, '指定序号时只能执行一个账号')
  assert.equal(singleRes[0].name, 'off.org', '指定序号应准确选择列表中的对应账号')

  // ---- 3.6 refreshBalances：列表刷新余额，HTTP 站实时查、浏览器站保留缓存 ----
  routes = {
    'GET https://agentrouter.org/api/user/self': { status: 200, body: { success: true, data: { id: 7, display_name: 'u7', quota: 2500000, used_quota: 0 } } }
  }
  const entryRB = {
    accounts: [
      { name: 'agentrouter.org', baseUrl: 'https://agentrouter.org', type: 'agentrouter', token: 't', siteUserId: 7, lastBalance: '$0.01' },
      { name: 'anyrouter.top', baseUrl: 'https://anyrouter.top', type: 'anyrouter', token: 't', siteUserId: 1, lastBalance: '$9.99' }
    ]
  }
  await refreshBalances(entryRB)
  assert.equal(entryRB.accounts[0].lastBalance, '$5.00', 'HTTP 站应实时刷新余额')
  assert.equal(entryRB.accounts[0].username, 'u7', '刷新时应同步用户名')
  assert.equal(entryRB.accounts[1].lastBalance, '$9.99', '浏览器站应保留缓存不实时查询')

  // ---- 3.7 Sub2API：refresh_token 轮换必须立刻写回，列表刷新不得回退到浏览器 ----
  const sub2api = (await import('../models/adapters/sub2api.js')).default
  const S2 = () => ({
    name: 's2.test', baseUrl: 'https://s2.test', type: 'sub2api', authMode: 'refresh',
    token: 'RT1', accessToken: '', tokenExpiresAt: null, siteUserId: null, lastBalance: '$1.00'
  })
  const refreshBodies = []
  let meAuth = null
  routes = {
    'POST https://s2.test/api/v1/auth/refresh': opts => {
      refreshBodies.push(JSON.parse(opts.body))
      return {
        status: 200,
        body: { code: 0, message: 'success', data: { access_token: 'AT2', refresh_token: 'RT2', expires_in: 86400 } }
      }
    },
    'GET https://s2.test/api/v1/auth/me': opts => {
      meAuth = opts.headers.Authorization
      return {
        status: 200,
        body: { code: 0, data: { id: 5, username: 's5', balance: 3.5, free_balance: 1.25, total_recharged: 10 } }
      }
    }
  }
  const s2 = S2()
  const s2Info = await sub2api.userInfo(s2)
  assert.equal(s2Info.ok, true)
  assert.equal(s2Info.balanceText, '$3.50 (免费 $1.25)', '站点余额本身是美元，不得再走 quota 换算')
  assert.equal(s2Info.siteUserId, 5, '需回传站点用户ID供 upsertAccount 去重')
  assert.deepEqual(refreshBodies, [{ refresh_token: 'RT1' }])
  assert.equal(meAuth, 'Bearer AT2')
  assert.equal(s2.token, 'RT2', '一次性 refresh_token 轮换后必须立刻写回账号')
  assert.equal(s2.accessToken, 'AT2')
  assert.ok(Number(s2.tokenExpiresAt) > Date.now(), '应记录 access_token 到期时间避免每次都烧 refresh')

  // 凭据全失效时列表刷新只能纯 HTTP 尝试：开浏览器过码要一两分钟，而这里 10 秒就超时，
  // 被丢下的浏览器任务仍会占着全局页面槽位，把后续签到一起拖慢。
  const savedBrowserEnable = cfgNow.browser.enable
  cfgNow.browser.enable = false // 兜底：万一真走到浏览器分支，立即失败而不是启动 Chrome
  routes = {}
  const deadS2 = { ...S2(), token: '', authMode: 'email', loginEmail: 'a@b.com', password: 'p' }
  const noBrowser = await sub2api.userInfo(deadS2, { allowBrowser: false })
  assert.equal(noBrowser.ok, false)
  assert.match(noBrowser.msg, /不启动浏览器/, '禁用浏览器时应明确返回原因而不是去过码')
  const entryS2 = { accounts: [deadS2] }
  await refreshBalances(entryS2)
  assert.equal(entryS2.accounts[0].lastBalance, '$1.00', '刷新失败应保留旧余额缓存')
  cfgNow.browser.enable = savedBrowserEnable

  // ---- Sub2API：站点未开启验证码时应直接 HTTP 登录，不启动浏览器 ----
  // 站点把三种验证码开关放在 /settings/public，适配器据此选择登录方式。
  // 读取失败必须按「可能需要验证码」处理，否则会让需要过码的站点无法登录。
  const capOffBody = {
    code: 0,
    data: { turnstile_enabled: false, aliyun_captcha_enabled: false, tencent_captcha_enabled: false }
  }
  const mkS2Login = host => ({
    name: host, baseUrl: `https://${host}`, type: 'sub2api', authMode: 'email',
    loginEmail: 'a@b.com', password: 'pw', token: '', accessToken: '', tokenExpiresAt: null
  })

  const loginBodies = []
  routes = {
    'GET https://nocap.test/api/v1/settings/public': { status: 200, body: capOffBody },
    'POST https://nocap.test/api/v1/auth/login': opts => {
      loginBodies.push(JSON.parse(opts.body))
      return {
        status: 200,
        body: {
          code: 0,
          data: {
            access_token: 'AT-H1', refresh_token: 'RT-H1', expires_in: 86400,
            user: { id: 11, username: 'h11' }
          }
        }
      }
    }
  }
  const noCap = mkS2Login('nocap.test')
  assert.equal((await sub2api.login(noCap)).ok, true, '验证码全部关闭时应直接 HTTP 登录成功')
  assert.deepEqual(loginBodies, [{ email: 'a@b.com', password: 'pw' }], '登录只提交邮箱与密码')
  assert.equal(noCap.accessToken, 'AT-H1')
  assert.equal(noCap.token, 'RT-H1', 'refresh_token 必须写回，否则下轮仍需重新登录')
  assert.equal(noCap.siteUserId, 11, '需回填站点用户 ID 用于去重')
  assert.equal(noCap.username, 'h11')
  assert.ok(Number(noCap.tokenExpiresAt) > Date.now())

  // 部分版本把凭据放在响应顶层而非 data 内，两种形状都需兼容
  routes = {
    'GET https://nocap2.test/api/v1/settings/public': { status: 200, body: capOffBody },
    'POST https://nocap2.test/api/v1/auth/login': {
      status: 200,
      body: { access_token: 'AT-H2', refresh_token: 'RT-H2', expires_in: 86400 }
    }
  }
  const topLevel = mkS2Login('nocap2.test')
  assert.equal((await sub2api.login(topLevel)).ok, true, '顶层凭据形状也应登录成功')
  assert.equal(topLevel.accessToken, 'AT-H2')
  assert.equal(topLevel.token, 'RT-H2')

  // 站点开启 Turnstile：不得直接 HTTP 登录，必须回退浏览器路径
  const savedBrowserEnable2 = cfgNow.browser.enable
  cfgNow.browser.enable = false // 用「浏览器方案已关闭」的报错证明确实走到浏览器分支
  routes = {
    'GET https://hascap.test/api/v1/settings/public': {
      status: 200,
      body: { code: 0, data: { turnstile_enabled: true, aliyun_captcha_enabled: false, tencent_captcha_enabled: false } }
    }
  }
  const hasCap = await sub2api.login(mkS2Login('hascap.test'))
  assert.equal(hasCap.ok, false, '开启验证码且浏览器方案关闭时应失败')
  assert.match(hasCap.msg, /人机验证/, '应落到浏览器过码分支而非直接 HTTP 登录')

  // 设置接口异常：按「可能需要验证码」处理，不得乐观地直接登录
  routes = {
    'GET https://badcfg.test/api/v1/settings/public': { status: 500, body: null },
    'POST https://badcfg.test/api/v1/auth/login': () => {
      throw new Error('读取不到验证码设置时不应尝试直接 HTTP 登录')
    }
  }
  const badCfg = await sub2api.login(mkS2Login('badcfg.test'))
  assert.equal(badCfg.ok, false)
  assert.match(badCfg.msg, /人机验证/, '读取不到设置应回退浏览器而非直接登录')

  // 读不到设置只是「这次没读到」，不能当成永久结论：若把失败也长期缓存，站点抽一次风
  // 就会让它在进程存活期内再也不试 HTTP 快路径，用户只能重启才能恢复
  let flakySettings = 0
  let flakyLogins = 0
  routes = {
    'GET https://flaky.test/api/v1/settings/public': () => {
      flakySettings++
      return flakySettings === 1 ? { status: 500, body: null } : { status: 200, body: capOffBody }
    },
    'POST https://flaky.test/api/v1/auth/login': () => {
      flakyLogins++
      return {
        status: 200,
        body: { code: 0, data: { access_token: 'AT-F', refresh_token: 'RT-F', expires_in: 86400 } }
      }
    }
  }
  assert.equal((await sub2api.login(mkS2Login('flaky.test'))).ok, false, '读不到设置时应回退浏览器')
  assert.equal(flakyLogins, 0, '读不到设置时不应发登录请求')
  assert.equal((await sub2api.login(mkS2Login('flaky.test'))).ok, false)
  assert.equal(flakySettings, 1, '短时间内不应对设置接口连环重探')

  const realNow = Date.now
  Date.now = () => realNow() + 90 * 1000 // 越过「没读到」的短有效期
  try {
    assert.equal((await sub2api.login(mkS2Login('flaky.test'))).ok, true, '站点恢复后应重新探测并走 HTTP 登录')
    assert.equal(flakySettings, 2, '短有效期过后应再探一次')
    assert.equal((await sub2api.login(mkS2Login('flaky.test'))).ok, true)
    assert.equal(flakySettings, 2, '确定的结论应在有效期内复用，不重复请求')
  } finally {
    Date.now = realNow
  }
  cfgNow.browser.enable = savedBrowserEnable2

  // ---- 3.9 Sub2API：赞助商签到（tbe）两段式 ----
  // 这类站点没有 /checkin 与 /check-in，签到要先 begin 拿一次性 token，
  // 等满站点声明的曝光秒数再 claim。等待必须遵守，提前提交会被判无效。
  const tbeStatusBody = done => ({
    code: 0,
    data: {
      config: { normal_checkin_enabled: true, sponsor_popup_seconds: 0 },
      today: '2026-09-05',
      normal_done: done,
      recent_records: done
        ? [{ checkin_type: 'normal', checkin_date: '2026-09-05T00:00:00Z', amount: 0.8634 }]
        : []
    }
  })
  const mkTbe = host => ({
    name: host, baseUrl: `https://${host}`, type: 'sub2api', authMode: 'email',
    loginEmail: 'a@b.com', password: 'pw', token: '', accessToken: 'AT-TBE',
    tokenExpiresAt: Date.now() + 3600e3
  })

  // 未签：两代旧形态 404 后落到 tbe，begin → claim 走通
  const tbeCalls = []
  routes = {
    'GET https://tbe.test/api/v1/checkin/status': { status: 404, body: null },
    'GET https://tbe.test/api/v1/check-in/status': { status: 404, body: null },
    'GET https://tbe.test/api/v1/tbe-sponsor-checkin/status': { status: 200, body: tbeStatusBody(false) },
    'POST https://tbe.test/api/v1/tbe-sponsor-checkin/normal/begin': opts => {
      tbeCalls.push(['begin', JSON.parse(opts.body)])
      return { status: 200, body: { code: 0, data: { token: 'TK-1', wait_seconds: 0, sponsor_name: '登仙赞助站' } } }
    },
    'POST https://tbe.test/api/v1/tbe-sponsor-checkin/normal/claim': opts => {
      tbeCalls.push(['claim', JSON.parse(opts.body)])
      return { status: 200, body: { code: 0, data: { amount: 0.8634 } } }
    }
  }
  const tbeRes = await sub2api.checkin(mkTbe('tbe.test'))
  assert.equal(tbeRes.ok, true, '赞助商签到应成功')
  assert.equal(tbeRes.already, false)
  assert.equal(tbeRes.awardText, '$0.86', '奖励金额在 amount 字段')
  assert.deepEqual(tbeCalls.map(c => c[0]), ['begin', 'claim'], '必须先 begin 再 claim')
  assert.equal(tbeCalls[1][1].token, 'TK-1', 'claim 要带 begin 给的一次性 token')
  assert.ok(tbeCalls[0][1].timezone, 'begin 要带时区，站点据此判断今天')

  // 已签：状态里 normal_done=true，直接报已签并带上今日奖励，不应再调 begin
  routes = {
    'GET https://tbedone.test/api/v1/checkin/status': { status: 404, body: null },
    'GET https://tbedone.test/api/v1/check-in/status': { status: 404, body: null },
    'GET https://tbedone.test/api/v1/tbe-sponsor-checkin/status': { status: 200, body: tbeStatusBody(true) },
    'POST https://tbedone.test/api/v1/tbe-sponsor-checkin/normal/begin': () => {
      throw new Error('已签到时不应再调 begin')
    }
  }
  const tbeDone = await sub2api.checkin(mkTbe('tbedone.test'))
  assert.equal(tbeDone.already, true, '已签应识别为 already')
  assert.equal(tbeDone.awardText, '$0.86', '已签时从 recent_records 取今日奖励')

  // begin 返回 409 ALREADY_DONE（状态与实际不一致时的兜底）也算已签，不算失败
  routes = {
    'GET https://tbenowait.test/api/v1/checkin/status': { status: 404, body: null },
    'GET https://tbenowait.test/api/v1/check-in/status': { status: 404, body: null },
    'GET https://tbenowait.test/api/v1/tbe-sponsor-checkin/status': { status: 200, body: tbeStatusBody(false) },
    'POST https://tbenowait.test/api/v1/tbe-sponsor-checkin/normal/begin': {
      status: 409,
      body: { code: 409, message: 'check-in already completed', reason: 'TBE_SPONSOR_CHECKIN_ALREADY_DONE' }
    }
  }
  const tbeRace = await sub2api.checkin(mkTbe('tbenowait.test'))
  assert.equal(tbeRace.ok, true, 'begin 报已签不应算失败')
  assert.equal(tbeRace.already, true)

  // 签到全链路：状态未签 → POST 领取 → 状态复核已签；奖励与余额都是站点直接给的美元
  let s2StatusCalls = 0
  routes = {
    'GET https://s2.test/api/v1/checkin/status': { status: 404, body: null },
    'GET https://s2.test/api/v1/check-in/status': () => {
      s2StatusCalls++
      const checked = s2StatusCalls > 2
      return {
        status: 200,
        body: {
          code: 0,
          data: {
            checked_in_today: checked, turnstile_required: false,
            today_reward: 0.5, balance: checked ? 4 : 3.5, free_balance: 0.25
          }
        }
      }
    },
    'POST https://s2.test/api/v1/check-in': {
      status: 200,
      body: { code: 0, data: { already_checked_in: false, reward_amount: 0.5, balance: 4, free_balance: 0.25 } }
    },
    'GET https://s2.test/api/v1/auth/me': {
      status: 200,
      body: { code: 0, data: { id: 5, username: 's5', balance: 4, free_balance: 0.25, total_recharged: 10 } }
    }
  }
  const s2Fresh = { ...S2(), token: '', accessToken: 'AT_OK', tokenExpiresAt: Date.now() + 3600000 }
  const s2Row = await checkinAccount(s2Fresh)
  assert.equal(s2Row.status, 'ok')
  assert.equal(s2Row.award, '+$0.50', 'Sub2API 奖励为美元金额，不得当成 quota 换算')
  assert.equal(s2Row.balance, '$4.00 (免费 $0.25)')

  // 重复签到：站点回 already_checked_in 时按今日已签展示今日奖励
  s2StatusCalls = 3
  routes['POST https://s2.test/api/v1/check-in'] = {
    status: 200,
    body: { code: 0, data: { already_checked_in: true, today_reward: 0.5, balance: 4, free_balance: 0.25 } }
  }
  const s2Again = await checkinAccount({ ...S2(), token: '', accessToken: 'AT_OK', tokenExpiresAt: Date.now() + 3600000 })
  assert.equal(s2Again.status, 'already')
  assert.equal(s2Again.award, '今日 +$0.50')

  // ---- Sub2API 新版形态：路径无连字符、字段整代改名，签到走 attempt + claim 两步 ----
  // 这一代站点上，旧代码会在 /check-in/status 拿到 404 并把站点当成「不支持签到」而静默跳过。
  // 用另一个域名：适配器按 host 缓存接口形态，复用 s2.test 会命中上面已探测出的旧版
  const S2V2 = () => ({ ...S2(), name: 's2v2.test', baseUrl: 'https://s2v2.test' })
  let v2ClaimBody = null
  let v2AttemptCalls = 0
  routes = {
    'GET https://s2v2.test/api/v1/checkin/status': {
      status: 200,
      body: {
        code: 0,
        data: {
          enabled: true,
          checked_in: false,
          captcha_enabled: false,
          captcha_provider: 'turnstile',
          captcha_site_key: '0xSITEKEY',
          reward_template: { type: 'gift_balance', value: 0.4 },
          balance: 3.6,
          gift_balance: 0.25
        }
      }
    },
    'POST https://s2v2.test/api/v1/checkin/attempt': () => {
      v2AttemptCalls++
      return {
        status: 200,
        body: {
          code: 0,
          data: {
            attempt_id: 'A1',
            captcha_provider: 'turnstile',
            captcha_site_key: '0xSITEKEY',
            captcha_action: 'daily_checkin',
            captcha_cdata: 'CD1'
          }
        }
      }
    },
    'POST https://s2v2.test/api/v1/checkin': {
      status: 200,
      capture: opts => { v2ClaimBody = JSON.parse(opts.body) },
      body: { code: 0, data: { already_checked_in: false, reward_amount: 0.4, balance: 4, gift_balance: 0.25 } }
    },
    'GET https://s2v2.test/api/v1/auth/me': {
      status: 200,
      body: { code: 0, data: { id: 5, username: 's5', balance: 4, gift_balance: 0.25, total_recharged: 10 } }
    }
  }
  const s2v2 = await checkinAccount({ ...S2V2(), token: '', accessToken: 'AT_OK', tokenExpiresAt: Date.now() + 3600000 })
  assert.equal(s2v2.status, 'ok', '新版形态应能正常签到，而不是被当成不支持签到')
  assert.equal(s2v2.award, '+$0.40', '新版的奖励字段是 reward_amount')
  // 免费额度也改了名：漏掉 gift_balance 就只会显示付费余额
  assert.equal(s2v2.balance, '$4.00 (免费 $0.25)', '新版的免费额度字段是 gift_balance')
  assert.equal(v2AttemptCalls, 0, '站点关闭验证码时不该多打一次 attempt')
  assert.deepEqual(v2ClaimBody, {}, '无需验证码时提交体不应带 attempt_id / captcha_token')

  // 开了 Turnstile：必须先换 attempt_id，再连同 captcha_token 一起提交
  const savedBrowserForV2 = cfgNow.browser.enable
  routes['GET https://s2v2.test/api/v1/checkin/status'] = {
    status: 200,
    body: {
      code: 0,
      data: {
        enabled: true, checked_in: false, captcha_enabled: true,
        captcha_provider: 'turnstile', captcha_site_key: '0xSITEKEY',
        reward_template: { value: 0.4 }, balance: 3.6, gift_balance: 0.25
      }
    }
  }
  cfgNow.browser.enable = false
  const s2NeedCaptcha = await checkinAccount({ ...S2V2(), token: '', accessToken: 'AT_OK', tokenExpiresAt: Date.now() + 3600000 })
  cfgNow.browser.enable = savedBrowserForV2
  assert.equal(s2NeedCaptcha.status, 'fail', '关掉浏览器方案时应如实报失败')
  assert.equal(v2AttemptCalls, 1, '开了验证码就必须先创建 attempt')

  // 验证方式换成插件不支持的 cap：直接说明，不再白等一轮过码
  routes['GET https://s2v2.test/api/v1/checkin/status'] = {
    status: 200,
    body: {
      code: 0,
      data: {
        enabled: true, checked_in: false, captcha_enabled: true,
        captcha_provider: 'cap', captcha_site_key: '874e289103',
        reward_template: { value: 0.4 }, balance: 3.6, gift_balance: 0.25
      }
    }
  }
  const s2Cap = await checkinAccount({ ...S2V2(), token: '', accessToken: 'AT_OK', tokenExpiresAt: Date.now() + 3600000 })
  assert.equal(s2Cap.status, 'fail')
  assert.match(s2Cap.msg, /cap/i, '不支持的验证方式要在文案里点名')
  assert.equal(v2AttemptCalls, 1, '验证方式不支持时不该再去创建 attempt')

  // ---- 4. probeAccount：new-api 命中 ----
  let capturedAuth = ''
  routes = {
    'GET https://n.com/api/user/self': (opts) => {
      capturedAuth = opts.headers.Authorization
      return { status: 200, body: { success: true, data: { id: 3, username: 'n', quota: 1000000, used_quota: 0 } } }
    }
  }
  let probe = await probeAccount('https://n.com', 'TOK', null)
  assert.equal(probe.ok, true)
  assert.equal(probe.type, 'newapi')
  assert.equal(probe.info.siteUserId, 3, '应从探测结果取回站点用户ID')
  assert.equal(capturedAuth, 'Bearer TOK')

  // ---- 5. probeAccount：new-api 失败 → Veloera 命中（需 siteUserId）----
  let veloHeaders = null
  routes = {
    'GET https://v.com/api/user/self': (opts) => {
      if (opts.headers.Authorization.startsWith('Bearer ')) {
        return { status: 401, body: { success: false, message: '未登录' } }
      }
      veloHeaders = opts.headers
      return { status: 200, body: { success: true, data: { id: 9, username: 'v', quota: 2000000, used_quota: 0 } } }
    }
  }
  probe = await probeAccount('https://v.com', 'VTOK', '9')
  assert.equal(probe.ok, true)
  assert.equal(probe.type, 'veloera')
  assert.equal(veloHeaders.Authorization, 'VTOK', 'Veloera 不应带 Bearer 前缀')
  assert.equal(veloHeaders['Veloera-User'], '9')

  // 未提供 siteUserId 时应提示补充用户ID
  routes = {
    'GET https://v.com/api/user/self': { status: 401, body: { success: false, message: '未登录' } }
  }
  probe = await probeAccount('https://v.com', 'VTOK', null)
  assert.equal(probe.ok, false)
  assert.match(probe.msg, /用户ID/)

  // ---- 配置跳过：只查余额，不签到，不把跳过记成实际签到 ----
  cfgNow.security.allowedPrivateHosts.push('skip-balance.test')
  const skipConfigBefore = cfgNow.skip.hosts
  cfgNow.skip.hosts = ['skip-balance.test']
  try {
    const account = {
      name: 'skip-balance.test', baseUrl: 'https://skip-balance.test', type: 'newapi',
      token: 'TEST_ONLY', lastBalance: '$9.00',
      lastCheckinAt: '2000-01-01T00:00:00.000Z', lastCheckinConfirmed: false
    }
    routes = { 'GET https://skip-balance.test/api/user/self': {
      body: { success: true, data: { quota: 2000000, used_quota: 0 } }
    } }
    networkCalls.length = 0
    const result = await checkinAccount(account)
    assert.equal(result.status, 'ok')
    assert.equal(result.statusText, '跳过签到')
    assert.equal(result.balance, '$4.00', '跳过站点仍应显示本次查询到的余额')
    assert.deepEqual(networkCalls, ['GET https://skip-balance.test/api/user/self'])
    assert.equal(account.lastBalance, '$4.00')
    assert.equal(account.lastCheckinAt, '2000-01-01T00:00:00.000Z')
    assert.equal(account.lastCheckinConfirmed, false)
    routes = { 'GET https://skip-balance.test/api/user/self': { status: 401, body: { success: false } } }
    assert.equal((await checkinAccount(account)).balance, '$4.00（缓存）')
    assert.equal(account.lastBalance, '$4.00', '显示标记不能污染原始缓存')
    assert.equal((await checkinAccount({ ...account, lastBalance: '-' })).balance, '-')
    routes = { 'GET https://skip-balance.test/api/user/self': {
      body: { success: true, data: { quota: 0, used_quota: 0 } }
    } }
    assert.equal((await checkinAccount(account)).balance, '$0.00')
  } finally { cfgNow.skip.hosts = skipConfigBefore }

  // 14个账号中3个跳过：提示统计11个，报告仍保留14条余额记录。
  const skipEvent = { user_id: 984, self_id: 10000, isGroup: false, msg: '#中转签到', sender: { nickname: '跳过测试' } }
  const skipStore = await import('../models/store.js')
  const { RelayCheckinCore: SkipCore } = await import('../apps/checkin.js')
  const { currentHost: skipCurrentHost } = await import('../host/index.js')
  const skipEntry = skipStore.ensureEntry(skipEvent)
  const skipAccounts = Array.from({ length: 14 }, (_, i) => ({
    name: `skip-count-${i}.test`, baseUrl: `https://skip-count-${i}.test`,
    type: [0, 1, 3].includes(i) ? 'sub2api' : 'newapi', token: 'TEST_ONLY',
    siteUserId: i + 1, accessToken: 'TEST_ACCESS', tokenExpiresAt: Date.now() + 3600000,
    auto: true, lastBalance: '$9.00'
  }))
  skipEntry.accounts = skipAccounts
  cfgNow.security.allowedPrivateHosts.push(...skipAccounts.map(a => a.name))
  cfgNow.skip.hosts = skipAccounts.slice(0, 3).map(a => a.name)
  routes = {}
  for (const a of skipAccounts) {
    if (a.type === 'sub2api') {
      routes[`GET ${a.baseUrl}/api/v1/auth/me`] = { body: { code: 0, data: { balance: 4, total_recharged: 0 } } }
      routes[`GET ${a.baseUrl}/api/v1/checkin/status`] = { status: 404 }
      routes[`GET ${a.baseUrl}/api/v1/check-in/status`] = { body: { code: 0, data: { enabled: true, checked_in_today: true } } }
    } else {
      routes[`GET ${a.baseUrl}/api/user/checkin?month=${month}`] = { body: { success: true, data: { stats: { checked_in_today: true, records: [] } } } }
      routes[`GET ${a.baseUrl}/api/user/self`] = { body: { success: true, data: { quota: 2000000, used_quota: 0 } } }
      routes[`GET ${a.baseUrl}/api/site/welfare/status`] = { status: 404 }
    }
  }
  const skipReplies = []
  let skipRender
  const skipHost = skipCurrentHost()
  installHost({ ...skipHost, renderTemplate: async (name, data) => { skipRender = data; return false } })
  try {
    const core = new SkipCore({ e: skipEvent, reply: async text => skipReplies.push(text) })
    await core.checkin()
    assert.match(skipReplies[0], /11 个账号/, '待签到数必须排除3个跳过项')
    assert.match(skipReplies[0], /1 个站点.*耗时较长/)
    assert.match(skipReplies[0], /3 个账号.*跳过签到.*查询余额/)
    assert.equal(skipRender.users[0].accounts.length, 14)
    for (const row of skipRender.users[0].accounts.slice(0, 3)) {
      assert.equal(row.statusText, '跳过签到')
      assert.equal(row.balance, '$4.00')
    }
    assert.equal(skipRender.summaryItems.find(item => item.tone === 'ok').value, 3)
    skipReplies.length = 0
    skipEvent.msg = '#中转签到 1'
    await core.checkin()
    assert.match(skipReplies[0], /跳过签到.*查询余额/)
    assert.equal(skipRender.users[0].accounts.length, 1)
    skipReplies.length = 0
    skipEvent.msg = '#中转签到'
    cfgNow.skip.hosts = skipAccounts.map(a => a.name)
    networkCalls.length = 0
    await core.checkin()
    assert.match(skipReplies[0], /14 个账号.*跳过签到.*查询余额/)
    assert.doesNotMatch(skipReplies[0], /依次签到|耗时较长/)
    assert.ok(networkCalls.every(key => key.endsWith('/api/user/self') || key.endsWith('/api/v1/auth/me')))
  } finally { cfgNow.skip.hosts = skipConfigBefore; installHost(skipHost) }

  // AnyRouter只读余额模式不能回退到浏览器；保留默认行为。
  const skipBrowserAdapter = (await import('../models/adapters/anyrouter.js')).default
  const skipBrowserEnable = cfgNow.browser.enable
  cfgNow.browser.enable = false
  routes = { 'GET https://anyrouter.top/api/user/self': { status: 200, body: null } }
  try {
    const result = await skipBrowserAdapter.userInfo({ name: 'anyrouter.top', baseUrl: 'https://anyrouter.top', token: 'TEST' }, { allowBrowser: false })
    assert.equal(result.ok, false)
    assert.match(result.msg, /本次不打开浏览器/)
  } finally { cfgNow.browser.enable = skipBrowserEnable }
  console.log('跳过余额、进度与浏览器保护 OK')

  // ---- 6. 网络错误重试后抛出，executor 兜底为失败结果 ----
  routes = {}
  const bad = await checkinAccount({ name: 'x.com', baseUrl: 'https://x.com', type: 'newapi', token: 't' })
  assert.equal(bad.status, 'fail')
  assert.ok(bad.msg.length > 0)

  // ---- 7. Turnstile 站点自动触发浏览器降级链路 ----
  // 站点未配置 site key 时应停在降级入口并给出明确提示（不触碰 puppeteer）
  routes = {
    'POST https://t.com/api/user/checkin': { status: 200, body: { success: false, message: 'Turnstile token 为空' } },
    'GET https://t.com/api/status': { status: 200, body: { success: true, data: {} } },
    'GET https://t.com/api/user/self': { status: 200, body: { success: true, data: { id: 1, quota: 500000, used_quota: 0 } } }
  }
  const ts = await checkinAccount({ name: 't.com', baseUrl: 'https://t.com', type: 'newapi', token: 'T', siteUserId: 1 })
  assert.equal(ts.status, 'fail')
  assert.match(ts.msg, /site key/, '应触发降级并提示缺少 site key')
  assert.equal(ts.balance, '$1.00', '降级失败不影响余额查询')

  // ---- 7.1 NewAPI：本轮前已签到时跳过 POST，并展示站点记录的今日奖励 ----
  let postCalls = 0
  routes = {
    [`GET https://newapi.test/api/user/checkin?month=${month}`]: {
      status: 200,
      body: { success: true, data: { stats: { checked_in_today: true, records: [{ checkin_date: today, quota_awarded: 250000 }] } } }
    },
    'POST https://newapi.test/api/user/checkin': () => {
      postCalls++
      return { status: 200, body: { success: true } }
    },
    'GET https://newapi.test/api/user/self': {
      status: 200,
      body: { success: true, data: { id: 1, quota: 2000000, used_quota: 0 } }
    }
  }
  const already = await checkinAccount({ name: 'newapi.test', baseUrl: 'https://newapi.test', type: 'newapi', token: 'T', siteUserId: 1 })
  assert.equal(postCalls, 0, '状态接口确认已签后不得再发 POST')
  assert.equal(already.status, 'already')
  assert.equal(already.statusText, '本轮前已签到')
  assert.equal(already.award, '今日 +$0.50')

  // ---- 7.2 POST 响应丢失：只发送一次，再由状态接口确认成功 ----
  let statusCalls = 0
  let selfStatusCalls = 0
  postCalls = 0
  routes = {
    [`GET https://newapi.test/api/user/checkin?month=${month}`]: () => {
      statusCalls++
      const checked = statusCalls >= 2
      return {
        status: 200,
        body: {
          success: true,
          data: { stats: { checked_in_today: checked, records: checked ? [{ checkin_date: today, quota_awarded: 500000 }] : [] } }
        }
      }
    },
    'POST https://newapi.test/api/user/checkin': () => {
      postCalls++
      throw new Error('connection reset after write')
    },
    'GET https://newapi.test/api/user/self': () => {
      selfStatusCalls++
      return {
        status: 200,
        body: { success: true, data: { id: 1, quota: selfStatusCalls === 1 ? 1000000 : 1500000, used_quota: 0 } }
      }
    }
  }
  const reconciled = await checkinAccount({ name: 'newapi.test', baseUrl: 'https://newapi.test', type: 'newapi', token: 'T', siteUserId: 1 })
  assert.equal(postCalls, 1, '非幂等 POST 网络失败后不得自动重试')
  assert.equal(reconciled.status, 'ok')
  assert.equal(reconciled.statusText, '状态复核成功')
  assert.equal(reconciled.award, '+$1.00')

  // ---- 7.3 请求重试策略：GET 可重试，POST 始终单次 ----
  let getAttempts = 0
  routes = {
    'GET https://x.com/retry-test': () => {
      getAttempts++
      if (getAttempts < 3) throw new Error('temporary')
      return { status: 200, body: { success: true } }
    }
  }
  const retriedGet = await request('https://x.com/retry-test')
  assert.equal(retriedGet.status, 200)
  assert.equal(getAttempts, 3)

  // ---- 7.4 每日抽奖：独立执行，一条站点记录的批注分别展示奖励 ----
  cfgNow.security.allowedPrivateHosts.push('lottery.test')
  const lotteryAccount = {
    name: 'lottery.test', baseUrl: 'https://lottery.test', type: 'newapi',
    token: 'LOTTERY_TEST_TOKEN', siteUserId: 21
  }
  let lotteryBalance = 1000000
  let lotteryPosts = 0
  let lotteryAuth = null
  routes = {
    [`GET https://lottery.test/api/user/checkin?month=${month}`]: { status: 404 },
    'GET https://lottery.test/api/user/self': () => ({
      body: { success: true, data: { quota: lotteryBalance, used_quota: 0 } }
    }),
    'POST https://lottery.test/api/user/checkin': () => {
      lotteryBalance += 250000
      return { body: { success: true } }
    },
    'GET https://lottery.test/api/site/welfare/status': {
      body: { success: true, data: { quota: 1250000, daily_lottery: { Done: false } } }
    },
    'POST https://lottery.test/api/site/welfare/lottery': opts => {
      lotteryPosts++
      lotteryAuth = opts.headers
      lotteryBalance += 7500000
      return { body: { success: true, data: {
        label: '每日抽奖获得 15.00 额度', net_quota: 7500000,
        balance_before: 1250000, balance_quota: lotteryBalance
      } } }
    }
  }
  const lotteryRows = await checkinEntry({ accounts: [{ ...lotteryAccount }] })
  assert.equal(lotteryRows.length, 1, '同一站点只能有一条记录，签到和每日抽奖应分列在批注里')
  assert.equal(lotteryRows[0].name, 'lottery.test')
  assert.equal(lotteryRows[0].statusText, '签到成功')
  assert.equal(lotteryRows[0].award, '+$15.50', '绿字奖励应合并本轮签到与抽奖所得')
  assert.equal(lotteryRows[0].balance, '$17.50', '站点余额显示全部活动结束后的余额')
  assert.equal(lotteryRows[0].msg, '签到：签到成功，+$0.50\n每日抽奖：抽奖成功，+$15.00')
  assert.equal(lotteryPosts, 1, '每日抽奖POST只提交一次')
  assert.equal(lotteryAuth.Authorization, 'Bearer LOTTERY_TEST_TOKEN')
  assert.equal(lotteryAuth['New-Api-User'], '21')

  // 无福利接口按站点缓存，避免每个账号、每次签到都探测不存在的路径。
  const { checkinAccountResults } = await import('../models/executor.js')
  const signedRoutes = host => ({
    [`GET https://${host}/api/user/checkin?month=${month}`]: {
      body: { success: true, data: { stats: { checked_in_today: true, records: [] } } }
    },
    [`GET https://${host}/api/user/self`]: {
      body: { success: true, data: { quota: 2000000, used_quota: 0 } }
    }
  })
  const lotteryAcc = (host, id = 21) => ({ ...lotteryAccount, name: host, baseUrl: `https://${host}`, siteUserId: id })
  cfgNow.security.allowedPrivateHosts.push('plain-lottery.test')
  let absentProbes = 0
  routes = {
    ...signedRoutes('plain-lottery.test'),
    'GET https://plain-lottery.test/api/site/welfare/status': () => {
      absentProbes++
      return { status: 404 }
    }
  }
  const plainRows = await checkinEntry({ accounts: [lotteryAcc('plain-lottery.test'), lotteryAcc('plain-lottery.test', 22)] })
  assert.equal(plainRows.length, 2, '不支持福利中心的站点只显示原签到行')
  assert.equal(absentProbes, 1, '不存在的福利接口应按站点缓存，不能逐账号重复探测')

  // 同一站点账号可能被多个用户同时触发；只共享互斥，不共享领取状态。
  cfgNow.security.allowedPrivateHosts.push('concurrent-lottery.test')
  let concurrentDone = false
  let concurrentPosts = 0
  routes = {
    ...signedRoutes('concurrent-lottery.test'),
    'GET https://concurrent-lottery.test/api/site/welfare/status': () => ({
      body: { success: true, data: { quota: 2000000, daily_lottery: { done: concurrentDone } } }
    }),
    'POST https://concurrent-lottery.test/api/site/welfare/lottery': () => {
      concurrentPosts++
      concurrentDone = true
      return { body: { success: true, data: { net_quota: 500000, balance_quota: 2500000 } } }
    }
  }
  const concurrentRows = await Promise.all([
    checkinAccountResults(lotteryAcc('concurrent-lottery.test')),
    checkinAccountResults(lotteryAcc('concurrent-lottery.test'))
  ])
  assert.equal(concurrentPosts, 1, '同一站点账号并发触发时每日抽奖只能提交一次')
  assert.deepEqual(concurrentRows.map(rows => rows[1].status).sort(), ['already', 'ok'])
  assert.equal(concurrentRows.find(rows => rows[1].status === 'already')[1].award, '', '今日已抽不重复展示新奖励')

  // POST响应丢失：只读复查，禁止再发一次POST，禁止凭余额差猜奖励。
  cfgNow.security.allowedPrivateHosts.push('lost-lottery.test')
  let lostPosts = 0
  let lostStatusReads = 0
  routes = {
    ...signedRoutes('lost-lottery.test'),
    'GET https://lost-lottery.test/api/site/welfare/status': () => {
      lostStatusReads++
      return { body: { success: true, data: {
        quota: lostPosts ? 9500000 : 2000000,
        daily_lottery: { Done: lostPosts > 0 }
      } } }
    },
    'POST https://lost-lottery.test/api/site/welfare/lottery': () => {
      lostPosts++
      throw new Error('connection reset after write')
    }
  }
  const lostRows = await checkinAccountResults(lotteryAcc('lost-lottery.test'))
  assert.equal(lostRows[1].status, 'ok', '抽奖POST响应丢失后应以只读状态复查确认领取')
  assert.equal(lostPosts, 1, '抽奖POST响应丢失不能重试')
  assert.equal(lostStatusReads, 2, 'POST前查状态、响应丢失后再复查一次')
  assert.equal(lostRows[1].award, '', '不能把复查余额的变化冒充抽奖奖励')
  assert.match(lostRows[1].msg, /复查/)

  // 空值、字符串和两个大小写字段冲突时都不能推断成“未抽”。
  for (const flags of [{}, { Done: 'false' }, { Done: false, done: true }, { Done: 'true', done: false }]) {
    routes = {
      ...signedRoutes('lottery.test'),
      'GET https://lottery.test/api/site/welfare/status': {
        body: { success: true, data: { daily_lottery: flags } }
      },
      'POST https://lottery.test/api/site/welfare/lottery': {
        body: { success: true, data: { net_quota: 500000 } }
      }
    }
    networkCalls.length = 0
    const rows = await checkinAccountResults(lotteryAcc('lottery.test'))
    assert.equal(rows[1].status, 'fail', '抽奖状态字段缺失、类型错误或冲突时必须停止领取')
    assert.equal(networkCalls.filter(key => key.startsWith('POST ')).length, 0)
  }

  // 已完成、已知需扣费均只读状态；不重复发奖，不碰幸运签到。
  for (const [flags, expectedStatus] of [[{ done: true }, 'already'], [{ Done: false, cost_quota: 1 }, 'fail']]) {
    routes = {
      ...signedRoutes('lottery.test'),
      'GET https://lottery.test/api/site/welfare/status': {
        body: { success: true, data: { quota: 2000000, daily_lottery: flags, checkin: { Done: false } } }
      }
    }
    networkCalls.length = 0
    const rows = await checkinAccountResults(lotteryAcc('lottery.test'))
    assert.equal(rows[1].status, expectedStatus)
    assert.equal(rows[1].award, '')
    assert.equal(networkCalls.filter(key => key.startsWith('POST ')).length, 0, '已领取或需扣费都不得提交')
  }

  // 兼容另行提供的跳过配置：本PR只负责不执行每日抽奖。
  // 签到本身的跳过与只读余额由#13负责；缺少skip配置时不影响普通站点。
  const savedSkipConfig = cfgNow.skip
  cfgNow.skip = { hosts: ['lottery.test'] }
  routes = signedRoutes('lottery.test')
  try {
    networkCalls.length = 0
    const rows = await checkinAccountResults(lotteryAcc('lottery.test'))
    assert.equal(rows.length, 1)
    assert.ok(networkCalls.every(key => !key.includes('/api/site/welfare/')), '命中跳过清单时不得探测或提交每日抽奖')
  } finally { cfgNow.skip = savedSkipConfig }

  // 503不可永久写成“不支持”，恢复后仍可识别并领取。
  cfgNow.security.allowedPrivateHosts.push('recover-lottery.test')
  let recoverReads = 0
  routes = {
    ...signedRoutes('recover-lottery.test'),
    'GET https://recover-lottery.test/api/site/welfare/status': () => {
      recoverReads++
      return recoverReads === 1 ? { status: 503 } : {
        body: { success: true, data: { daily_lottery: { Done: true } } }
      }
    }
  }
  assert.equal((await checkinAccountResults(lotteryAcc('recover-lottery.test'))).length, 1)
  assert.equal((await checkinAccountResults(lotteryAcc('recover-lottery.test')))[1].status, 'already')
  assert.equal(recoverReads, 2)
  routes = {
    ...signedRoutes('recover-lottery.test'),
    'GET https://recover-lottery.test/api/site/welfare/status': { status: 503 }
  }
  const failedProbe = await checkinAccountResults(lotteryAcc('recover-lottery.test'))
  assert.equal(failedProbe[0].status, 'already')
  assert.equal(failedProbe[1].status, 'fail', '已识别的抽奖能力暂时故障，应单列失败而非隐去')

  // 没有奖励字段时不猜；签到失败不能被独立的抽奖成功覆盖。
  routes = {
    [`GET https://lottery.test/api/user/checkin?month=${month}`]: { status: 404 },
    'GET https://lottery.test/api/user/self': { body: { success: true, data: { quota: 2000000, used_quota: 0 } } },
    'POST https://lottery.test/api/user/checkin': { body: { success: false, message: '余额不足' } },
    'GET https://lottery.test/api/site/welfare/status': {
      body: { success: true, data: { daily_lottery: { Done: false } } }
    },
    'POST https://lottery.test/api/site/welfare/lottery': {
      body: { success: true, data: { label: '每日抽奖获得 15.00 额度', balance_before: 2000000, balance_quota: 9500000 } }
    }
  }
  const failedSignAccount = { ...lotteryAcc('lottery.test'), lastCheckinAt: '2000-01-01T00:00:00.000Z', lastCheckinConfirmed: false }
  const independentRows = await checkinAccountResults(failedSignAccount)
  assert.equal(independentRows[0].status, 'fail', '抽奖成功不能洗白签到失败')
  assert.equal(independentRows[1].status, 'ok')
  assert.equal(independentRows[1].award, '', 'label及余额差不能代替明确的抽奖奖励字段')
  assert.equal(failedSignAccount.lastCheckinAt, '2000-01-01T00:00:00.000Z', '抽奖不得覆盖签到日期')
  assert.equal(failedSignAccount.lastCheckinConfirmed, false, '抽奖不得覆盖签到确认状态')
  assert.equal(failedSignAccount.lastBalance, '$19.00', '抽奖后余额应更新账号缓存')
  assert.equal(networkCalls.filter(key => key.includes('/api/site/welfare/') &&
    !['GET https://lottery.test/api/site/welfare/status', 'POST https://lottery.test/api/site/welfare/lottery',
      'GET https://recover-lottery.test/api/site/welfare/status'].includes(key)).length, 0, '只允许福利状态GET与每日抽奖POST')
  console.log('每日抽奖行为与安全边界 OK')

  // 绑定入口也要执行独立抽奖，并将结果交给同一套图片/文字输出。
  cfgNow.security.allowedPrivateHosts.push('binding-lottery.test')
  const { currentHost } = await import('../host/index.js')
  const { RelayCheckinCore } = await import('../apps/checkin.js')
  const originalHost = currentHost()
  let bindingRender = null
  const bindingReplies = []
  let bindingDone = false
  routes = {
    ...signedRoutes('binding-lottery.test'),
    'GET https://binding-lottery.test/api/site/welfare/status': () => ({
      body: { success: true, data: { quota: bindingDone ? 2500000 : 2000000, daily_lottery: { Done: bindingDone } } }
    }),
    'POST https://binding-lottery.test/api/site/welfare/lottery': () => {
      bindingDone = true
      return { body: { success: true, data: { net_quota: 500000, balance_quota: 2500000 } } }
    }
  }
  installHost({ ...originalHost, renderTemplate: async (name, data) => {
    bindingRender = { name, data }
    return false // 图片不可用，验证文字兜底也包含抽奖结果。
  } })
  try {
    const core = new RelayCheckinCore({
      e: { user_id: 987, self_id: 10000, isGroup: false, sender: { nickname: '测试用户' } },
      reply: async text => { bindingReplies.push(text) }
    })
    const bound = await core.saveAccount(lotteryAcc('binding-lottery.test'), { username: 'u', siteUserId: 21, balanceText: '$4.00' })
    assert.equal(bindingRender.data.users[0].accounts.length, 1, '绑定结果也只能有一条站点记录')
    assert.match(bindingRender.data.users[0].accounts[0].statusText, /添加成功/)
    assert.equal(bindingRender.data.users[0].accounts[0].balance, '$5.00')
    assert.equal(bindingRender.data.users[0].accounts[0].award, '今日 +$1.00', '签到在更早轮次完成时，绿字合计本轮抽奖所得')
    assert.match(bindingRender.data.users[0].accounts[0].msg, /每日抽奖：抽奖成功，\+\$1\.00/)
    assert.equal(bound.balance, '$5.00', '绑定通知显示最后一次抽奖后的余额')
    assert.match(bindingReplies.at(-1), /每日抽奖/)
    assert.equal(bindingReplies.at(-1).split('\n').length, 2, '同一站点的文字批注明细应保留换行')
    assert.match(bindingReplies.at(-1), /\+\$1\.00/)
    assert.equal(bindingRender.data.summaryItems.find(item => item.tone === 'notice').label, '已完成 / 待核')

    networkCalls.length = 0
    await core.saveAccount(lotteryAcc('binding-lottery.test'), { username: 'u', siteUserId: 21, balanceText: '$5.00' }, { ok: true, already: true })
    assert.match(bindingRender.data.users[0].accounts[0].msg, /每日抽奖：今日已抽/)
    assert.ok(networkCalls.every(key => key.includes('/api/site/welfare/')), '绑定已带签到结果时不可重新签到，只复查抽奖')
  } finally { installHost(originalHost) }

  // 同站不同账号的领取状态必须隔离，换日则以新读到的站点状态为准。
  cfgNow.security.allowedPrivateHosts.push('accounts-lottery.test', 'uncertain-lottery.test')
  const drawnUsers = new Set(['22'])
  const accountPosts = []
  routes = {
    ...signedRoutes('accounts-lottery.test'),
    'GET https://accounts-lottery.test/api/site/welfare/status': opts => ({
      body: { success: true, data: { daily_lottery: { Done: drawnUsers.has(opts.headers['New-Api-User']) } } }
    }),
    'POST https://accounts-lottery.test/api/site/welfare/lottery': opts => {
      const uid = opts.headers['New-Api-User']
      accountPosts.push(uid)
      drawnUsers.add(uid)
      return { body: { success: true, data: { net_quota: 0, balance_quota: 2000000 } } }
    }
  }
  const isolatedRows = await checkinEntry({ accounts: [lotteryAcc('accounts-lottery.test', 21), lotteryAcc('accounts-lottery.test', 22)] })
  assert.equal(isolatedRows.length, 2, '同站两个账号仍只显示两条记录')
  assert.match(isolatedRows[0].msg, /每日抽奖：抽奖成功/)
  assert.match(isolatedRows[1].msg, /每日抽奖：今日已抽/)
  assert.deepEqual(accountPosts, ['21'])
  assert.match(isolatedRows[0].msg, /每日抽奖：抽奖成功，\+\$0\.00/, '零奖励也应明确写在批注中')
  drawnUsers.clear() // 模拟站点换日重置，插件不得沿用昨日done缓存。
  const nextDayRows = await checkinAccountResults(lotteryAcc('accounts-lottery.test', 21))
  assert.equal(nextDayRows[1].status, 'ok')
  assert.deepEqual(accountPosts, ['21', '21'])

  let uncertainPosts = 0
  routes = {
    ...signedRoutes('uncertain-lottery.test'),
    'GET https://uncertain-lottery.test/api/site/welfare/status': {
      body: { success: true, data: { daily_lottery: { Done: false } } }
    },
    'POST https://uncertain-lottery.test/api/site/welfare/lottery': () => {
      uncertainPosts++
      return { status: 502, body: null }
    }
  }
  const uncertainRows = await checkinAccountResults(lotteryAcc('uncertain-lottery.test'))
  assert.equal(uncertainRows[0].status, 'already')
  assert.equal(uncertainRows[1].status, 'unknown', '服务端异常且状态未确认时不能虚报领取成功')
  assert.equal(uncertainPosts, 1, 'HTTP 5xx也不得重试领取POST')
  routes['POST https://uncertain-lottery.test/api/site/welfare/lottery'] = {
    body: { success: false, message: '今天已经抽奖过啦' }
  }
  const raceRows = await checkinAccountResults(lotteryAcc('uncertain-lottery.test'))
  assert.equal(raceRows[1].statusText, '今日已抽')
  assert.equal(raceRows[1].award, '')

  // 404负缓存必须有期限，站点后来增加福利中心仍能重新识别。
  const actualNow = Date.now
  try {
    const future = actualNow() + 7 * 60 * 60 * 1000
    Date.now = () => future
    routes = {
      ...signedRoutes('plain-lottery.test'),
      'GET https://plain-lottery.test/api/site/welfare/status': {
        body: { success: true, data: { daily_lottery: { done: true } } }
      }
    }
    assert.equal((await checkinAccountResults(lotteryAcc('plain-lottery.test')))[1].status, 'already')
  } finally { Date.now = actualNow }

  // 余额查询/列表不执行福利动作；自动关闭的账号也不参与抽奖。
  const { queryEntry } = await import('../models/executor.js')
  routes = signedRoutes('lottery.test')
  networkCalls.length = 0
  await queryEntry({ accounts: [lotteryAcc('lottery.test')] })
  await refreshBalances({ accounts: [lotteryAcc('lottery.test')] })
  assert.ok(networkCalls.every(key => key.endsWith('/api/user/self')))
  networkCalls.length = 0
  assert.deepEqual(await checkinEntry({ accounts: [{ ...lotteryAcc('lottery.test'), auto: false }] }, { autoOnly: true }), [])
  assert.equal(networkCalls.length, 0)
  const { combineCheckinResults } = await import('../models/executor.js')
  const rawFailure = JSON.stringify(independentRows)
  const combinedFailure = combineCheckinResults(independentRows)
  assert.equal(combinedFailure.status, 'fail', '批注归并不能洗白签到失败')
  assert.match(combinedFailure.msg, /签到：签到失败.*余额不足/)
  assert.match(combinedFailure.msg, /每日抽奖：抽奖成功/)
  assert.equal(JSON.stringify(independentRows), rawFailure, '展示归并不得修改执行层的原始活动结果')
  assert.match(combineCheckinResults(failedProbe).msg, /每日抽奖：抽奖失败/)
  console.log('每日抽奖并发、换日、复核与入口回归 OK')

  // ---- 8. AnyRouter：浏览器只负责取 WAF cookie，接口调用走普通 HTTP ----
  const anyrouter = (await import('../models/adapters/anyrouter.js')).default
  const AR2 = { name: 'anyrouter.top', baseUrl: 'https://anyrouter.top', type: 'anyrouter', token: 'S', siteUserId: 8 }
  let sentCookie = null
  routes = {
    'GET https://anyrouter.top/api/user/self': opts => {
      sentCookie = opts.headers?.Cookie
      return { status: 200, body: { success: true, data: { id: 8, username: 'a', quota: 2500000, used_quota: 0 } } }
    }
  }
  const arInfo = await anyrouter.userInfo(AR2)
  assert.equal(arInfo.ok, true, '纯 HTTP 可用时不应启动浏览器')
  assert.equal(arInfo.balanceText, '$5.00')
  assert.equal(sentCookie, 'session=S', '无 WAF cookie 缓存时直接用 session 请求')

  // WAF cookie 按 host 共享时也不能把上一个用户的 session 带给下一个用户。
  const isolatedHeaders = anyrouter.buildHeaders(
    { token: 'SECOND_SESSION', siteUserId: 9 },
    'session=FIRST_SESSION; acw_sc__v2=WAF_VALUE'
  )
  assert.equal(
    isolatedHeaders.Cookie,
    'session=SECOND_SESSION; acw_sc__v2=WAF_VALUE',
    'WAF 缓存不得污染当前账号 session'
  )

  // 被 WAF 拦回（非 JSON）且浏览器方案关闭时，应明确报原因而不是静默卡住
  const savedEnable = cfgNow.browser.enable
  cfgNow.browser.enable = false
  routes = { 'GET https://anyrouter.top/api/user/self': { status: 200, body: null } }
  const arBlocked = await anyrouter.userInfo(AR2)
  assert.equal(arBlocked.ok, false)
  assert.match(arBlocked.msg, /浏览器方案未启用/)
  cfgNow.browser.enable = savedEnable
  console.log('适配器行为 OK')

  // ---- 7. art-template 渲染模板（与 TRSS-Yunzai 同引擎）----
  const art = (await import('art-template')).default
  const tplDir = path.join(ROOT, 'resources', 'template')
  const users = [
    { nickname: '用户A', userId: '111', sectionMark: '壹', sectionText: '用户一', accounts: [
      { name: 'a.com', status: 'ok', statusText: '签到成功', award: '+$0.50', balance: '$12.30', msg: '' },
      { name: 'b.com', status: 'fail', statusText: '签到失败', award: '', balance: '-', msg: '凭据无效或已过期 (HTTP 401)' }
    ] },
    { nickname: '用户B', userId: '222', sectionMark: '贰', sectionText: '用户二', accounts: [
      { name: 'agentrouter.org', status: 'unknown', statusText: 'Session 有效·未重登', award: '', balance: '$25.00', msg: '签到未确认' }
    ] }
  ]
  const summaryItems = [
    { label: '结果条目', tone: '', mark: '叁', value: 3 },
    { label: '执行成功', tone: 'ok', mark: '壹', value: 1 },
    { label: '已签 / 待核', tone: 'notice', mark: '壹', value: 1 },
    { label: '执行异常', tone: 'fail', mark: '壹', value: 1 }
  ]
  let html = art(path.join(tplDir, 'result.html'), {
    title: '中转站定时签到', subtitle: '第 1/2 页', time: '2026-08-03 08:10',
    seal: { top: '签到', bottom: '已毕' }, summaryItems, users
  })
  assert.ok(html.includes('用户A') && html.includes('Session 有效·未重登') && html.includes('第 1/2 页'))
  assert.ok(html.includes('status-mark ok') && html.includes('status-mark fail'))
  assert.ok(html.includes('叁') && html.includes('3 条') && html.includes('用户一'), '大写数字必须同时带普通数字/序号注释')
  assert.ok(html.includes('凭据无效'))

  const { renderResult } = await import('../models/render.js')
  const renderHost = currentHost()
  installHost({ ...renderHost, renderTemplate: async (name, data) => art(path.join(tplDir, `${name}.html`), data) })
  try {
    const lotteryHtml = await renderResult({ title: '中转站签到', users: [{ nickname: '测试用户', userId: '123', accounts: lotteryRows }] })
    assert.equal((lotteryHtml.match(/class="acc-row"/g) || []).length, 1, '结果图不能把每日抽奖画成第二个站点')
    assert.ok(lotteryHtml.includes('每日抽奖') && lotteryHtml.includes('抽奖成功'))
    assert.ok(lotteryHtml.includes('+$0.50') && lotteryHtml.includes('+$15.00'))
    assert.ok(lotteryHtml.includes('已完成 / 待核'))
    assert.ok(lotteryHtml.includes('+$15.50'), '绿字奖励应合并签到与抽奖所得')
    assert.ok(lotteryHtml.includes('批注：签到：签到成功，+$0.50\n每日抽奖：抽奖成功，+$15.00'))
    assert.match(fs.readFileSync(path.join(tplDir, 'result.html'), 'utf8'), /\.acc-msg\s*\{[^}]*white-space:\s*pre-line/s, '批注明细的换行必须在实际渲染时保留')

  } finally { installHost(renderHost) }


  html = art(path.join(tplDir, 'result.html'), {
    title: '中转站账号', subtitle: '', time: 'T', seal: { top: '账号', bottom: '已录' },
    summaryItems, users: [{ nickname: '用户A', userId: '111', sectionMark: '壹', sectionText: '用户一', accounts: [
      { name: 'anyrouter.top (u)', status: 'ok', statusText: '添加成功 / 签到成功', award: '', balance: '$12.30', msg: '' }
    ] }]
  })
  assert.equal((html.match(/class="acc-row"/g) || []).length, 1, '绑定成功结果应将添加与签到合并为一条账号记录')
  assert.ok(html.includes('添加成功 / 签到成功'))

  html = art(path.join(tplDir, 'result.html'), {
    title: '中转站签到', subtitle: '', time: 'T', seal: { top: '签到', bottom: '已毕' },
    summaryItems, users: [users[0]]
  })
  assert.ok(!html.includes('subtitle">'), '无副标题时不应输出 subtitle 节点')

  html = art(path.join(tplDir, 'list.html'), {
    nickname: 'N', userId: '111', autoText: '已开启', accountCount: 1, accountCountMark: '壹', time: 'T',
    accounts: [{
      index: 1, indexMark: '壹', indexText: '账号一', name: 'a.com (u1)', baseUrl: 'https://a.com', typeLabel: 'new-api', tokenMasked: 'abcd****wxyz',
      balance: '$12.30', checkinText: '今日已签', checkinClass: 'on', autoText: '定时开', autoClass: 'on'
    }]
  })
  assert.ok(html.includes('a.com (u1)') && html.includes('abcd****wxyz') && !html.includes('暂无账号'))
  assert.ok(html.includes('余额 $12.30') && html.includes('今日已签') && html.includes('定时开'), '列表应展示余额与签到/定时状态')
  assert.ok(html.includes('账号一') && html.includes('· 1'), '账号大写序号必须同时带普通序号注释')
  assert.ok(html.includes('#中转签到 序号'), '账号列表应直接提示指定序号单独签到的方法')
  html = art(path.join(tplDir, 'list.html'), {
    nickname: 'N', userId: '1', autoText: '已开启', accountCount: 0, accountCountMark: '零', time: 'T', accounts: []
  })
  assert.ok(html.includes('暂无账号'))

  html = art(path.join(tplDir, 'help.html'), { time: 'T' })
  assert.ok(html.includes('#中转添加') && html.includes('#中转定时'))
  for (const file of ['help.html', 'list.html', 'result.html']) {
    const source = fs.readFileSync(path.join(tplDir, file), 'utf8')
    assert.match(source, /id="container"/, `${file} 应提供 TRSS 截图根节点`)
    assert.match(source, /#container\s*\{[^}]*width:\s*800px/s, `${file} 应使用 800px 原生画布`)
    assert.doesNotMatch(source, /\bzoom\s*:/, `${file} 不应使用会导致旧版 TRSS 截图裁切的 zoom`)
    assert.doesNotMatch(source, /transform:\s*scale\s*\(/, `${file} 不应使用需要运行时配合的 CSS scale`)
  }
  // 出图参数在宿主适配层里（TRSS 走 Yunzai 的 lib/puppeteer，NG 走插件自带渲染）
  assert.match(fs.readFileSync(path.join(ROOT, 'host', 'trss.js'), 'utf8'), /imgType:\s*'webp'/, 'TRSS 模板截图应使用 webp')
  assert.match(fs.readFileSync(path.join(ROOT, 'ng', 'render.js'), 'utf8'), /type:\s*'png'/, 'NG 模板截图应使用无损 PNG')
  console.log('模板渲染 OK')

  // ---- 9. NewAPI 原生 PoW：站点要求 PoW 挑战时自动取题、计算 nonce 并携带参数重发 ----
  {
    const cryptoMod = await import('node:crypto')
    const powAdapter = (await import('../models/adapters/newapi.js')).default
    // 与站点 worker 相同的判定：SHA-256(prefix+nonce) 前 difficulty 个 bit 全 0
    const powMeets = (digest, difficulty) => {
      if (difficulty <= 0) return true
      const full = Math.floor(difficulty / 8)
      const rem = difficulty % 8
      for (let i = 0; i < full; i++) if (digest[i] !== 0) return false
      if (rem > 0 && full < digest.length) return (digest[full] & (255 << (8 - rem))) === 0
      return true
    }
    const solveExpected = (prefix, difficulty) => {
      for (let s = 0; ; s++) {
        const candidate = s.toString(16).padStart(8, '0')
        if (powMeets(cryptoMod.createHash('sha256').update(prefix + candidate, 'utf8').digest(), difficulty)) return candidate
      }
    }

    // 9.1 适配器级：先拒绝 → 取题 → 解算 → 带 pow_challenge/pow_nonce 精确重发 → 成功
    const prefixA = 'pow-prefix-a'
    const nonceA = solveExpected(prefixA, 8)
    let noPowPosts = 0
    let powPosts = 0
    let challengeGets = 0
    routes = {
      'POST https://newapi.test/api/user/checkin': () => {
        noPowPosts++
        return { status: 200, body: { success: false, message: 'PoW challenge and nonce are required' } }
      },
      'GET https://newapi.test/api/user/pow/challenge?action=checkin': () => {
        challengeGets++
        return { status: 200, body: { success: true, data: { challenge_id: 'powc-a', prefix: prefixA, difficulty: 8 } } }
      },
      [`POST https://newapi.test/api/user/checkin?pow_challenge=powc-a&pow_nonce=${nonceA}`]: () => {
        powPosts++
        return { status: 200, body: { success: true, message: '签到成功', data: { quota_awarded: 12500000 } } }
      }
    }
    const powOk = await powAdapter.checkin({ name: 'newapi.test', baseUrl: 'https://newapi.test', type: 'newapi', token: 't', siteUserId: 1 })
    assert.equal(powOk.ok, true, '解出 PoW 后重发应签到成功')
    assert.equal(powOk.awardQuota, 12500000)
    assert.equal(noPowPosts, 1, '未带 PoW 的首次 POST 只发一次')
    assert.equal(challengeGets, 1)
    assert.equal(powPosts, 1, '应携带 pow_challenge/pow_nonce 精确重发一次')

    // 9.2 取题失败：给出明确原因，不再发第二次 POST
    routes = {
      'POST https://newapi.test/api/user/checkin': { status: 200, body: { success: false, message: 'PoW challenge and nonce are required' } },
      'GET https://newapi.test/api/user/pow/challenge?action=checkin': { status: 500, body: { success: false, message: 'boom' } }
    }
    const powFail = await powAdapter.checkin({ name: 'newapi.test', baseUrl: 'https://newapi.test', type: 'newapi', token: 't', siteUserId: 1 })
    assert.equal(powFail.ok, false)
    assert.match(String(powFail.msg), /取题|挑战题/, '失败原因应说明没拿到挑战题')

    // 9.3 完整链路：状态未签 → POST 要求 PoW → 解算重发成功 → 报告成功与奖励
    const nowP = new Date()
    const monthP = `${nowP.getFullYear()}-${String(nowP.getMonth() + 1).padStart(2, '0')}`
    const prefixC = 'pow-prefix-c'
    const nonceC = solveExpected(prefixC, 8)
    let powPostsC = 0
    let selfCallsC = 0
    routes = {
      [`GET https://newapi.test/api/user/checkin?month=${monthP}`]: { status: 200, body: { success: true, data: { stats: { checked_in_today: false, records: [] } } } },
      'POST https://newapi.test/api/user/checkin': { status: 200, body: { success: false, message: 'PoW challenge and nonce are required' } },
      'GET https://newapi.test/api/user/pow/challenge?action=checkin': { status: 200, body: { success: true, data: { challenge_id: 'powc-c', prefix: prefixC, difficulty: 8 } } },
      [`POST https://newapi.test/api/user/checkin?pow_challenge=powc-c&pow_nonce=${nonceC}`]: () => {
        powPostsC++
        return { status: 200, body: { success: true, message: '签到成功', data: { quota_awarded: 12500000 } } }
      },
      'GET https://newapi.test/api/user/self': () => {
        selfCallsC++
        return { status: 200, body: { success: true, data: { id: 1, quota: selfCallsC === 1 ? 12500000 : 25000000, used_quota: 0 } } }
      }
    }
    const powAccount = await checkinAccount({ name: 'newapi.test', baseUrl: 'https://newapi.test', type: 'newapi', token: 'T', siteUserId: 1 })
    assert.equal(powAccount.status, 'ok', '完整链路 PoW 签到应成功')
    assert.match(String(powAccount.award), /\+\$25\.00/, '奖励应为余额差额 $25')
    assert.equal(powPostsC, 1)
  }

  console.log('\n全部行为测试通过 ✓')
} finally {
  global.fetch = realFetch
  if (fs.existsSync(DATA)) fs.rmSync(DATA, { recursive: true, force: true })
  if (hadData) fs.renameSync(backup, DATA)
}

// config.js 的 chokidar watcher 会保持进程存活（生产为热更新所需），测试显式退出
process.exit(0)
