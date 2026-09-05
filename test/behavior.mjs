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
global.fetch = async (url, opts = {}) => {
  const key = `${opts.method || 'GET'} ${url}`
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
    'nocap.test', 'nocap2.test', 'hascap.test', 'badcfg.test'
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
  cfgNow.browser.enable = savedBrowserEnable2

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

  console.log('\n全部行为测试通过 ✓')
} finally {
  global.fetch = realFetch
  if (fs.existsSync(DATA)) fs.rmSync(DATA, { recursive: true, force: true })
  if (hadData) fs.renameSync(backup, DATA)
}

// config.js 的 chokidar watcher 会保持进程存活（生产为热更新所需），测试显式退出
process.exit(0)
