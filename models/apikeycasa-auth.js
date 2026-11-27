import { request } from './adapters/common.js'
import { persist } from './store.js'
import { isApikeyCasaSite } from './apikeycasa-policy.js'

const pending = new WeakMap()
const SAFETY_MS = 5 * 60 * 1000
const LOGIN_HINT = 'apikey.casa 登录失败，请检查邮箱和密码后重新绑定'
export const CASA_TOKEN_EXPIRED = 'Auth token 无效或已过期，请重新登录 apikey.casa 后更新 Auth token，或使用 #中转添加邮箱 apikey.casa 改为自动登录'

export function casaAuthFailed(res) {
  const code = String(res.json?.code ?? '').toUpperCase()
  return res.status === 401 || res.status === 403
    || ['INVALID_TOKEN', 'UNAUTHORIZED', 'FORBIDDEN', 'TOKEN_EXPIRED'].includes(code)
}

function url(account, path) {
  return String(account.baseUrl || '').replace(/\/+$/, '') + '/api/v1' + path
}
function success(res) {
  return res.status >= 200 && res.status < 300 && res.json?.code === 0
}
function applyTokens(account, data) {
  const seconds = Number(data?.expires_in)
  if (!data?.access_token || typeof data.access_token !== 'string'
    || !data.refresh_token || typeof data.refresh_token !== 'string'
    || !Number.isFinite(seconds) || seconds <= 0) {
    return { ok: false, msg: 'apikey.casa 未返回完整登录凭据，请稍后重新绑定' }
  }
  if (account.siteUserId != null && data.user?.id != null
    && String(account.siteUserId) !== String(data.user.id)) {
    return { ok: false, msg: 'apikey.casa 登录账号与原绑定不一致，请删除原绑定后重新添加' }
  }
  // 邮箱模式沿用插件存储约定：token 为刷新令牌，accessToken 为短期请求凭据。
  account.token = data.refresh_token
  account.accessToken = data.access_token
  account.tokenExpiresAt = Date.now() + seconds * 1000
  // 刷新令牌会轮换，必须立即保存，不能等外层查询或签到完成。
  try { persist() } catch {
    return { ok: false, msg: 'apikey.casa 登录凭据保存失败，请检查服务器存储后重试' }
  }
  return { ok: true, token: account.accessToken }
}

async function renew(account) {
  if (account.token) {
    let res
    try {
      res = await request(url(account, '/auth/refresh'), {
        method: 'POST', body: { refresh_token: account.token }, maxRetry: 0, retryBeforeSend: false, sensitive: true
      })
    } catch { return { ok: false, msg: 'apikey.casa 续期请求未完成，请稍后重试' } }
    if (success(res)) return applyTokens(account, res.json.data)
    // 网络故障/限流/服务异常不等同于凭据失效，避免连续密码登录。
    if (![400, 401].includes(res.status)) {
      return { ok: false, msg: 'apikey.casa 暂时无法续期，请稍后重试' }
    }
  }
  if (!String(account.loginEmail || '').trim() || !account.password) {
    return { ok: false, msg: 'apikey.casa 未保存邮箱密码，请用 #中转添加邮箱 apikey.casa 重新绑定' }
  }
  let settings
  try { settings = await request(url(account, '/settings/public'), { maxRetry: 0, timeoutMs: 5000, sensitive: true }) }
  catch { return { ok: false, msg: '无法读取 apikey.casa 登录设置，请稍后重试' } }
  if (!success(settings) || typeof settings.json.data?.turnstile_enabled !== 'boolean') {
    return { ok: false, msg: '无法确认 apikey.casa 登录设置，请稍后重试' }
  }
  const cfg = settings.json.data
  if (cfg.turnstile_enabled || cfg.tencent_captcha_enabled || cfg.aliyun_captcha_enabled) {
    return { ok: false, msg: 'apikey.casa 已开启登录验证码，请先在网页登录，再用 #中转添加 apikey.casa AuthToken值 绑定' }
  }
  let res
  try {
    res = await request(url(account, '/auth/login'), {
      method: 'POST', body: { email: String(account.loginEmail).trim(), password: String(account.password) },
      maxRetry: 0, retryBeforeSend: false, sensitive: true
    })
  } catch { return { ok: false, msg: 'apikey.casa 登录请求未完成，请稍后重试' } }
  const data = res.json?.data
  if (data?.requires_2fa || data?.require_2fa || data?.two_factor_required || data?.temp_token) {
    return { ok: false, msg: 'apikey.casa 账号需要二次验证，请在网页完成登录后使用 Auth token 绑定' }
  }
  if (!success(res)) return { ok: false, msg: res.status === 429 ? 'apikey.casa 登录过于频繁，请稍后重试' : LOGIN_HINT }
  return applyTokens(account, data)
}

export async function ensureCasaToken(account, { failedToken } = {}) {
  if (!isApikeyCasaSite(account) || account.authMode !== 'email') {
    return { ok: false, msg: LOGIN_HINT }
  }
  const underway = pending.get(account)
  if (underway) return underway
  // 其他请求已完成续期时复用新凭据，不再消费一次刷新令牌。
  if (account.accessToken && (failedToken && account.accessToken !== failedToken
    || !failedToken && Number(account.tokenExpiresAt) - SAFETY_MS > Date.now())) {
    return { ok: true, token: account.accessToken }
  }
  const task = renew(account)
  pending.set(account, task)
  try { return await task } finally { if (pending.get(account) === task) pending.delete(account) }
}

/** 只读请求允许鉴权失败后续期并重试一次；签到 POST 始终不重放。 */
export async function casaRead(account, endpoint) {
  let token = account.token
  if (account.authMode === 'email') {
    const auth = await ensureCasaToken(account)
    if (!auth.ok) return { authError: auth.msg }
    token = auth.token
  }
  let res = await request(url(account, endpoint), { headers: { Authorization: 'Bearer ' + token }, sensitive: true })
  if (account.authMode === 'email' && casaAuthFailed(res)) {
    const auth = await ensureCasaToken(account, { failedToken: token })
    if (!auth.ok) return { authError: auth.msg }
    res = await request(url(account, endpoint), { headers: { Authorization: 'Bearer ' + auth.token }, sensitive: true })
  }
  return res
}
