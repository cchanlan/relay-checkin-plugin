import { request } from './common.js'
import { sub2apiLogin } from '../browser.js'
import { persist } from '../store.js'
import { logger } from '../../host/index.js'

/**
 * Sub2API（自研 Go 网关，前端标题 "Sub2API - AI API Gateway"）
 *
 * 与 new-api 系完全不同：接口前缀 /api/v1，响应统一包一层
 * { code: 0, message: "success", data: {...} }，余额字段本身就是美元
 * （balance / free_balance），不存在 new-api 的 quota 换算。
 *
 * 鉴权是 JWT：邮箱密码登录换 access_token（24 小时）+ refresh_token。
 * 签到是否要人机验证由 /checkin/status 决定，因此：
 *   1. 优先用未过期的 access_token 直接调接口；
 *   2. 过期则用 refresh_token 纯 HTTP 续期（不开浏览器）；
 *   3. refresh 也失效时才开浏览器过码重新登录。
 *
 * refresh_token 是一次性的：每次 /auth/refresh 都会轮换，旧值立刻 401，
 * 所以换到新值必须立即写回 account 交由 store 落盘，否则下轮只能重新过码。
 *
 * 签到接口存在两代形态，实测同一套前端代码分别对应：
 *   新版：GET /checkin/status + POST /checkin/attempt + POST /checkin
 *         字段 checked_in / captcha_enabled / captcha_provider / captcha_site_key，
 *         提交要带上 attempt 换来的 attempt_id 与 captcha_token（三步）。
 *   旧版：GET /check-in/status + POST /check-in
 *         字段 checked_in_today / turnstile_required / turnstile_site_key（一步）。
 * 两者路径只差一个连字符，旧代码在新版站点上会拿到 404 并被当成「不支持签到」
 * 而静默跳过，所以这里按 host 探测一次形态再缓存。
 */

const API = '/api/v1'
// access_token 名义有效期 24 小时，留 5 分钟余量避免边界上恰好过期
const EXPIRY_SAFETY_MS = 5 * 60 * 1000

// 探测顺序：新版在前。命中后按 host 缓存，避免每轮签到都白打一次 404
const CHECKIN_SHAPES = [
  { name: 'v2', statusPath: '/checkin/status', attemptPath: '/checkin/attempt', claimPath: '/checkin' },
  { name: 'v1', statusPath: '/check-in/status', attemptPath: '', claimPath: '/check-in' }
]
const checkinShapeCache = new Map()

// attempt 相关的失败都由服务端判定上下文（IP、指纹、有效期），重试没有意义，
// 但要能在日志里区分开，否则只会看到一个笼统的「签到失败」。
// 名单取自站点前端的同名集合，另外补上验证码绑定信息不符的几种。
const ATTEMPT_REASONS = new Set([
  'DAILY_CHECKIN_ATTEMPT_REQUIRED',
  'DAILY_CHECKIN_ATTEMPT_INVALID',
  'DAILY_CHECKIN_ATTEMPT_EXPIRED',
  'DAILY_CHECKIN_ATTEMPT_USED',
  'DAILY_CHECKIN_ATTEMPT_IP_MISMATCH',
  'DAILY_CHECKIN_ATTEMPT_CONTEXT_MISMATCH',
  'DAILY_CHECKIN_ATTEMPT_STORE_UNAVAILABLE'
])

// 验证码本身有效，但与 attempt 声明的绑定信息对不上（action / cData / hostname），
// 或同一 token 被重放。这类要单独说明：重试能解决，但得重新取 attempt 再过一次码
const CAPTCHA_BINDING_REASONS = new Set([
  'DAILY_CHECKIN_CAPTCHA_ACTION_MISMATCH',
  'DAILY_CHECKIN_CAPTCHA_CDATA_MISMATCH',
  'DAILY_CHECKIN_CAPTCHA_HOSTNAME_MISMATCH',
  'CAPTCHA_TOKEN_REPLAYED',
  'CAPTCHA_REPLAY_GUARD_UNAVAILABLE'
])

function hostOf(account) {
  try { return new URL(account.baseUrl).hostname } catch { return String(account.baseUrl || '') }
}

function apiUrl(account, path) {
  return `${account.baseUrl}${API}${path}`
}

/**
 * 解包 { code, message, data }。code 为 0 才算成功（HTTP 200 也可能是业务失败）
 */
function unwrap(res) {
  const json = res?.json
  if (json && typeof json === 'object' && 'code' in json) {
    const ok = json.code === 0 || json.code === '0'
    return { ok, data: json.data ?? null, msg: json.message || json.msg || '', reason: json.reason || '' }
  }
  return { ok: false, data: null, msg: json?.message || `响应异常 (HTTP ${res?.status})`, reason: '' }
}

function usd(value) {
  const n = Number(value)
  return Number.isFinite(n) ? `$${n.toFixed(2)}` : null
}

/**
 * 余额展示：付费余额为主，免费额度单独标出（两者用途不同，合计会误导）。
 * 免费额度的字段名随接口换代改过：旧版 free_balance，新版 gift_balance。
 * 用 ?? 而不是 ||：旧版余额为 0 时不能被当成缺失而去读另一个字段。
 */
function balanceText(data) {
  const paid = usd(data?.balance)
  const free = usd(data?.free_balance ?? data?.gift_balance)
  if (paid && free) return `${paid} (免费 ${free})`
  return paid || free || '-'
}

function hasLogin(account) {
  return Boolean(String(account?.loginEmail || '').trim()) && Boolean(String(account?.password || ''))
}

/**
 * 取一个可用 access_token。三级兜底，任何一级成功都会把新凭据写回 account。
 * @param {boolean} forceRenew true 时跳过内存中的 access_token（用于 401 重试）
 * @param {boolean} allowBrowser false 时禁止回退到浏览器登录（列表刷余额等短超时场景用：
 *   开浏览器过码要一两分钟，调用方 10 秒就超时了，任务却还在后台占用全局页面槽位）
 */
async function ensureToken(account, { forceRenew = false, allowBrowser = true } = {}) {
  const notExpired = account.tokenExpiresAt
    ? Number(account.tokenExpiresAt) - EXPIRY_SAFETY_MS > Date.now()
    : false
  if (!forceRenew && account.accessToken && notExpired) {
    return { ok: true, token: account.accessToken }
  }

  // 1) refresh_token 纯 HTTP 续期
  const renewed = await renewByRefreshToken(account)
  if (renewed.ok) return { ok: true, token: renewed.token }

  // 2) 站点未开启验证码时用邮箱密码直接 HTTP 登录：省去浏览器过码的耗时与
  // 页面槽位占用；allowBrowser=false 的短超时场景同样适用
  if (hasLogin(account) && await captchaDisabled(account)) {
    const direct = await loginByPassword(account)
    if (direct.ok) return { ok: true, token: direct.token }
  }

  // 3) 浏览器过码重新登录
  if (!allowBrowser) {
    return { ok: false, msg: '凭据已过期，需重新登录（本次查询不启动浏览器，请执行 #中转签到 重新登录）' }
  }
  if (!hasLogin(account)) {
    // 刷新令牌绑定的账号没有密码可用，必须让用户重新取一次
    return {
      ok: false,
      msg: account.authMode === 'refresh'
        ? '刷新令牌已失效，请用「#中转添加刷新令牌 地址」重新绑定（该站点无法自动过人机验证）'
        : 'Session 已过期且未保存邮箱密码，请重新绑定该站点'
    }
  }
  // 浏览器层的熔断与启动失败是 throw 出来的，这里转成统一的失败返回，
  // 避免异常穿透 adapter.login / getCheckinStatus 等约定返回对象的接口
  let login
  try {
    login = await sub2apiLogin(account)
  } catch (err) {
    return { ok: false, msg: err?.message || String(err) }
  }
  if (!login.ok) return { ok: false, msg: login.msg }
  applyTokens(account, login.data)
  if (login.data.user?.id != null) account.siteUserId = login.data.user.id
  if (login.data.user?.username) account.username = login.data.user.username
  return { ok: true, token: login.data.access_token }
}

/**
 * 用 refresh_token 换一对新凭据（纯 HTTP，不开浏览器）。
 * 站点每次都会轮换 refresh_token 并立刻作废旧值，所以换到就必须写回 account。
 */
async function renewByRefreshToken(account) {
  if (!account.token) return { ok: false, msg: '没有可用的刷新令牌' }
  const res = await request(apiUrl(account, '/auth/refresh'), {
    method: 'POST',
    body: { refresh_token: account.token }
  })
  const { ok, data, msg } = unwrap(res)
  if (ok && data?.access_token) {
    applyTokens(account, data)
    return { ok: true, token: data.access_token }
  }
  logger.info(`[relay-checkin-plugin] ${account.name} refresh_token 已失效（${msg || `HTTP ${res.status}`}）`)
  return { ok: false, msg: msg || `刷新令牌无效 (HTTP ${res.status})` }
}

// 站点公共设置按 host 缓存：验证码开关很少变动，避免每次登录都多一次请求
const captchaFlagCache = new Map()

/**
 * 站点是否三种验证码全部关闭。全部关闭时可直接 HTTP 登录，无需浏览器过码。
 * 读取失败按「可能需要验证码」处理，仍走浏览器路径，避免误判导致无法登录。
 */
async function captchaDisabled(account) {
  const host = hostOf(account)
  if (captchaFlagCache.has(host)) return captchaFlagCache.get(host)
  let disabled = false
  try {
    const res = await request(apiUrl(account, '/settings/public'))
    const data = res.json?.data
    // 以字段存在为准而非仅看 HTTP 200：非 Sub2API 站点也可能在该路径返回其它内容
    if (res.status === 200 && res.json?.code === 0 && data && 'turnstile_enabled' in data) {
      disabled = data.turnstile_enabled !== true
        && data.aliyun_captcha_enabled !== true
        && data.tencent_captcha_enabled !== true
    }
  } catch {
    disabled = false
  }
  captchaFlagCache.set(host, disabled)
  return disabled
}

/**
 * 邮箱密码直接 HTTP 登录。仅在 captchaDisabled 为真时调用；
 * 若站点实际需要验证码或启用了两步验证，此处返回业务失败，由调用方回退浏览器路径。
 *
 * 成功响应有两种形状：凭据位于 data 内，或直接位于顶层。两者都需兼容。
 */
async function loginByPassword(account) {
  const res = await request(apiUrl(account, '/auth/login'), {
    method: 'POST',
    body: { email: String(account.loginEmail || '').trim(), password: String(account.password || '') }
  })
  const json = res.json || {}
  const failed = 'code' in json && json.code !== 0 && json.code !== '0'
  const data = json.data && typeof json.data === 'object' ? json.data : json
  if (!failed && data?.access_token) {
    applyTokens(account, data)
    if (data.user?.id != null) account.siteUserId = data.user.id
    if (data.user?.username) account.username = data.user.username
    return { ok: true, token: data.access_token }
  }
  const msg = json.message || json.msg || `HTTP ${res.status}`
  logger.info(`[relay-checkin-plugin] ${account.name} HTTP 登录未成功（${msg}）`)
  return { ok: false, msg }
}

/**
 * 写回登录/续期得到的凭据。token 字段存 refresh_token（长期凭据，由 store 落盘），
 * accessToken 与到期时间同样落盘，避免每次重启都白烧一次 refresh。
 *
 * 必须在这里就地落盘，不能只等调用链末尾的 persist()：站点每次 /auth/refresh 都会
 * 轮换 refresh_token 并立刻作废旧值，而 refreshBalances 之类有超时的调用方在超时后
 * 不会等这次续期跑完（那轮 persist 早已结束），新 refresh_token 就只留在内存里，
 * 下一轮必然 401 且不可逆——只能让用户重新绑定。
 */
function applyTokens(account, data) {
  account.accessToken = data.access_token
  if (data.refresh_token) account.token = data.refresh_token
  const expiresIn = Number(data.expires_in)
  account.tokenExpiresAt = Number.isFinite(expiresIn) && expiresIn > 0
    ? Date.now() + expiresIn * 1000
    : null
  // 落盘失败（磁盘满、文件被占用）只记日志：凭据已在内存，不能让本次签到直接失败
  try {
    persist()
  } catch (err) {
    logger.error(`[relay-checkin-plugin] ${account.name} 凭据落盘失败，refresh_token 可能丢失: ${err?.message || err}`)
  }
}

/**
 * 带 access_token 发请求，遇 401/INVALID_TOKEN 自动续期重试一次
 */
async function authed(account, path, { method = 'GET', body = null, allowBrowser = true } = {}) {
  let auth = await ensureToken(account, { allowBrowser })
  if (!auth.ok) return { authFailed: true, msg: auth.msg }

  const send = token => request(apiUrl(account, path), {
    method,
    headers: { Authorization: `Bearer ${token}` },
    body
  })

  let res = await send(auth.token)
  const invalidToken = res.status === 401 ||
    /INVALID_TOKEN|UNAUTHORIZED/i.test(String(res.json?.code || ''))
  if (invalidToken) {
    auth = await ensureToken(account, { forceRenew: true, allowBrowser })
    if (!auth.ok) return { authFailed: true, msg: auth.msg }
    res = await send(auth.token)
  }
  return res
}

const adapter = {
  type: 'sub2api',
  label: 'Sub2API',
  checkinPath: `${API}/check-in`,
  // 奖励额度由站点直接返回美元金额，无需用前后余额差推算
  compareBalance: false,
  reconcileByBalance: false,

  buildHeaders(account) {
    return {
      Authorization: `Bearer ${account.accessToken || ''}`,
      'Content-Type': 'application/json'
    }
  },

  async userInfo(account, { allowBrowser = true } = {}) {
    const res = await authed(account, '/auth/me', { allowBrowser })
    if (res.authFailed) return { ok: false, msg: res.msg }
    const { ok, data, msg } = unwrap(res)
    if (!ok || !data) return { ok: false, msg: msg || '获取用户信息失败' }
    return {
      ok: true,
      username: data.username || data.email || '',
      siteUserId: data.id,
      // 站点余额本身是美元，不能再进 quotaToUsd
      quota: null,
      usedQuota: null,
      balanceText: balanceText(data),
      usedText: usd(data.total_recharged) ?? '-'
    }
  },

  async getCheckinStatus(account) {
    const host = hostOf(account)
    const cached = checkinShapeCache.get(host)
    const shapes = cached ? [cached] : CHECKIN_SHAPES
    for (let i = 0; i < shapes.length; i++) {
      const shape = shapes[i]
      const isLast = i + 1 >= shapes.length
      let res
      try {
        res = await authed(account, shape.statusPath)
      } catch (err) {
        // 探测阶段的请求异常先让给下一个形态；到最后一个还失败才算真失败
        if (!isLast) continue
        throw err
      }
      if (res.authFailed) return { supported: true, ok: false, msg: res.msg }
      // 只有 404 才算「这个形态不对」，其余状态码都按当前形态解析
      if (res.status === 404 && !isLast) continue
      if (res.status === 404) return { supported: false }
      if (!cached) {
        checkinShapeCache.set(host, shape)
        logger.info(`[relay-checkin-plugin] ${host} 使用 ${shape.name} 版签到接口（${API}${shape.statusPath}）`)
      }
      return { ...parseCheckinStatus(res), shape }
    }
    return { supported: false }
  },

  async checkin(account) {
    const status = await this.getCheckinStatus(account)
    if (status.supported === false) return { ok: false, already: false, msg: '站点没有签到接口' }
    if (status.ok && status.enabled === false) {
      return { ok: false, already: false, msg: '站点已关闭签到功能' }
    }
    if (status.ok && status.checked) {
      return {
        ok: true,
        already: true,
        confirmed: true,
        awardText: status.awardText,
        balanceText: status.balanceText
      }
    }
    if (!status.ok) return { ok: false, already: false, msg: status.msg }
    // 站点可以把签到验证换成 cap / hcaptcha / recaptcha，这些插件都还不会过，
    // 明说比让用户等一轮超时更有用。validation 用 'unsupported'：executor 认得出
    // 它不是 turnstile/pow/captcha，于是跳过所有降级尝试并原样保留这句提示
    if (status.unsupportedCaptcha) {
      return {
        ok: false,
        already: false,
        validation: 'unsupported',
        msg: `签到改用 ${status.unsupportedCaptcha} 验证，暂不支持自动通过`
      }
    }

    const shape = status.shape || checkinShapeCache.get(hostOf(account)) || CHECKIN_SHAPES[1]
    // 新版是三步：attempt 换 attempt_id → 过码 → 带 attempt_id + captcha_token 提交。
    // attempt 自带 expires_at 且服务端会校验 IP/上下文，所以取到就要尽快过码提交。
    let attemptId = ''
    let siteKey = status.siteKey
    let captchaAction = ''
    let captchaCdata = ''
    if (status.captchaRequired && shape.attemptPath) {
      const attempt = await authed(account, shape.attemptPath, { method: 'POST', body: {} })
      if (attempt.authFailed) return { ok: false, already: false, msg: attempt.msg }
      const parsedAttempt = unwrap(attempt)
      if (!parsedAttempt.ok || !parsedAttempt.data?.attempt_id) {
        if (/ALREADY_DONE|already checked in/i.test(`${parsedAttempt.reason} ${parsedAttempt.msg}`)) {
          return { ok: true, already: true, confirmed: true, balanceText: status.balanceText }
        }
        logger.warn(`[relay-checkin-plugin] ${account.name} 创建签到凭证失败`
          + `（HTTP ${attempt.status}${parsedAttempt.reason ? `｜${parsedAttempt.reason}` : ''}）`
          + `${parsedAttempt.msg ? `：${parsedAttempt.msg}` : ''}`)
        return { ok: false, already: false, msg: parsedAttempt.msg || '创建签到凭证失败，请稍后重试' }
      }
      attemptId = parsedAttempt.data.attempt_id
      // attempt 会带自己的 site key 与挑战绑定信息，全部以 attempt 为准：
      // action / cData 对不上时后端回 DAILY_CHECKIN_CAPTCHA_ACTION_MISMATCH
      siteKey = parsedAttempt.data.captcha_site_key || siteKey
      captchaAction = parsedAttempt.data.captcha_action || ''
      captchaCdata = parsedAttempt.data.captcha_cdata || ''
      const provider = String(parsedAttempt.data.captcha_provider || '').toLowerCase()
      if (provider && provider !== 'none' && provider !== 'turnstile') {
        return {
          ok: false,
          already: false,
          validation: 'unsupported',
          msg: `签到改用 ${provider} 验证，暂不支持自动通过`
        }
      }
    }

    // 签到开了 Turnstile 时先在浏览器里取 token（登录本身也可能顺带完成）
    let turnstileToken = ''
    if (status.captchaRequired) {
      const solved = await sub2apiLogin(account, {
        siteKey,
        tokenOnly: true,
        action: captchaAction,
        cdata: captchaCdata
      })
      if (!solved.ok) {
        // 已经开过浏览器了，别让执行器再降级去试 new-api 风格的过码：
        // 那条路在这类站点上必然拿不到 site key，只会用兜底文案盖掉这里的真实原因
        return { ok: false, already: false, validation: 'turnstile', browserTried: true, msg: solved.msg }
      }
      turnstileToken = solved.turnstileToken || ''
    }

    // 两代形态的字段名不同：新版认 captcha_token + attempt_id，旧版认 turnstile_token
    const body = shape.attemptPath
      ? { attempt_id: attemptId || undefined, captcha_token: turnstileToken || undefined }
      : { turnstile_token: turnstileToken }
    const res = await authed(account, shape.claimPath, { method: 'POST', body })
    if (res.authFailed) return { ok: false, already: false, msg: res.msg }
    const parsed = parseSub2apiCheckin(res)
    // 这一轮已经用浏览器过过码了，提交仍失败时同样不该再降级。
    // 字段名跟着接口换代改成了 captchaRequired，别再写 turnstileRequired（恒 undefined）
    if (status.ok && status.captchaRequired) parsed.browserTried = true
    return parsed
  },

  async login(account) {
    const auth = await ensureToken(account, { forceRenew: true })
    if (!auth.ok) return { ok: false, msg: auth.msg }
    return { ok: true }
  },

  /**
   * 只用刷新令牌换凭据，绝不回退到浏览器登录。
   * 供「#中转添加刷新令牌」校验：那类站点本来就过不了码，
   * 回退只会白等两分钟再报一个无关的过码失败。
   */
  async renew(account) {
    return await renewByRefreshToken(account)
  }
}

/**
 * 解析签到响应。成功时 data 与 /check-in/status 同构，
 * already_checked_in 为真代表本次是重复签到。
 */
export function parseSub2apiCheckin(res) {
  const { ok, data, msg, reason } = unwrap(res)
  if (CAPTCHA_BINDING_REASONS.has(String(reason))) {
    // token 有效但绑定信息不符：下一轮会重新取 attempt 并按它声明的 action/cData 过码
    return { ok: false, already: false, msg: '验证凭据与站点声明的绑定信息不符，下轮会重新取凭证' }
  }
  if (ATTEMPT_REASONS.has(String(reason))) {
    // attempt 类失败是服务端对 IP / 指纹 / 有效期的判定，重试同一份凭证没用
    return { ok: false, already: false, msg: '签到凭证未被站点接受，请稍后重试' }
  }
  if (/RATE_LIMITED/i.test(reason)) {
    return { ok: false, already: false, msg: '签到过于频繁，已被站点限流，请稍后重试' }
  }
  if (/ALREADY_DONE/i.test(reason)) {
    return { ok: true, already: true, confirmed: true, msg: '今日已签到' }
  }
  if (/CAPTCHA|TURNSTILE/i.test(reason) || /turnstile|captcha/i.test(msg)) {
    return { ok: false, already: false, validation: 'turnstile', msg: msg || '签到要求人机验证' }
  }
  if (res.status === 401 || res.status === 403) {
    return { ok: false, already: false, msg: '凭据无效，请重新绑定' }
  }
  if (!ok) {
    if (/already|已签/i.test(msg)) return { ok: true, already: true, confirmed: true, msg: '今日已签到' }
    return { ok: false, already: false, msg: msg || '签到失败' }
  }
  const already = data?.already_checked_in === true
  return {
    ok: true,
    already,
    confirmed: true,
    awardText: usd(data?.reward_amount)
      ?? usd(data?.today_reward)
      ?? usd(data?.reward_template?.value)
      ?? null,
    balanceText: balanceText(data),
    msg: ''
  }
}

/**
 * 解析两代形态的签到状态。字段名整代变过，用 ?? 而不是 || ：
 * checked_in 为 false 时不能被当成缺失而回落到另一个字段。
 */
export function parseCheckinStatus(res) {
  const { ok, data, msg } = unwrap(res)
  const checked = data?.checked_in ?? data?.checked_in_today
  if (!ok || typeof checked !== 'boolean') {
    return { supported: true, ok: false, msg: msg || `签到状态查询失败 (HTTP ${res.status})` }
  }
  const captchaOn = (data.captcha_enabled ?? data.turnstile_required) === true
  const provider = String(data.captcha_provider || (captchaOn ? 'turnstile' : '')).toLowerCase()
  const knownProvider = !provider || provider === 'none' || provider === 'turnstile'
  return {
    supported: true,
    ok: true,
    checked,
    // 站点可以整体关掉签到功能，这时 enabled 为 false 但接口仍在
    enabled: data.enabled !== false,
    captchaRequired: captchaOn && knownProvider,
    unsupportedCaptcha: captchaOn && !knownProvider ? provider : '',
    siteKey: data.captcha_site_key || data.turnstile_site_key || '',
    awardText: checked
      ? (usd(data.today_reward) ?? usd(data.reward_template?.value) ?? null)
      : null,
    balanceText: balanceText(data)
  }
}

export { balanceText as sub2apiBalanceText, unwrap as unwrapSub2api, hasLogin as hasSub2apiLogin }
export default adapter
