import { request, parseUserInfo, parseCheckinResult, deriveAwardQuota } from './common.js'
import { fetchWafCookies } from '../browser.js'
import { getConfig } from '../config.js'
import { logger } from '../../host/index.js'

const WAF_MSG = '站点拦截未放行，请稍后重试'

/**
 * WAF cookie 缓存（host -> { cookieHeader, at }）：
 * 阿里云 WAF 的 acw_sc__v2 有效期较长，缓存后多数签到无需再开浏览器
 */
const wafCache = new Map()
const WAF_TTL = 25 * 60 * 1000

function cookieHeaderForAccount(account, wafCookieHeader = '') {
  const session = String(account?.token || '').trim()
  const wafCookies = String(wafCookieHeader || '')
    .split(';')
    .map(part => part.trim())
    .filter(Boolean)
    .filter(part => !/^session\s*=/i.test(part))
  return [`session=${session}`, ...wafCookies].filter(Boolean).join('; ')
}

function getCached(host) {
  const c = wafCache.get(host)
  if (c && Date.now() - c.at < WAF_TTL) return c.cookieHeader
  wafCache.delete(host)
  return null
}

/**
 * AnyRouter 系（anyrouter.top 及同源站，带阿里云 WAF）
 * 鉴权：Cookie: session=<值> + New-Api-User: <站点用户ID>
 * 流程：浏览器过 WAF 取 cookie（可缓存） → 用普通 HTTP 带这些 cookie 调接口
 * 参考：dctx-team/Regular-inspection、millylee/anyrouter-check-in
 */
export default {
  type: 'anyrouter',
  label: 'AnyRouter',

  buildHeaders(account, cookieHeader = null) {
    return {
      // WAF cookie 可按 host 缓存，但 session 必须始终来自当前账号，
      // 防止多个用户先后绑定同一站点时串用第一个人的会话。
      Cookie: cookieHeaderForAccount(account, cookieHeader),
      'New-Api-User': String(account.siteUserId ?? ''),
      'X-Requested-With': 'XMLHttpRequest',
      'Content-Type': 'application/json'
    }
  },

  /**
   * 取可用的 WAF cookie：优先用缓存，失效则开浏览器重新获取
   * @returns {Promise<{ok: true, cookieHeader: string}|{ok: false, msg: string}>}
   */
  async ensureCookies(account, { forceRefresh = false } = {}) {
    const host = new URL(account.baseUrl).hostname
    if (!forceRefresh) {
      const cached = getCached(host)
      if (cached) return { ok: true, cookieHeader: cached }
    }
    if (!getConfig().browser.enable) {
      return { ok: false, msg: '浏览器方案未启用，请主人把配置里的 browser.enable 打开' }
    }
    const res = await fetchWafCookies(account)
    if (res.wafBlocked || !res.cookieHeader) return { ok: false, msg: WAF_MSG }
    wafCache.set(host, { cookieHeader: res.cookieHeader, at: Date.now() })
    return { ok: true, cookieHeader: res.cookieHeader }
  },

  /**
   * 带 WAF cookie 请求接口。GET 被 WAF 拦回时可刷新 cookie 重试一次；
   * POST 不重发，避免首次已成功但响应丢失时发生重复签到。
   * @returns {Promise<{status: number, json: object|null}|{failed: string}>}
   */
  async apiCall(account, path, method = 'GET') {
    const attempts = String(method).toUpperCase() === 'GET' ? 2 : 1
    for (let attempt = 0; attempt < attempts; attempt++) {
      const c = await this.ensureCookies(account, { forceRefresh: attempt > 0 })
      if (!c.ok) return { failed: c.msg }
      const res = await request(`${account.baseUrl}${path}`, {
        method,
        headers: this.buildHeaders(account, c.cookieHeader)
      })
      // 拿到 JSON 说明已穿过 WAF；非 JSON 多为拦截页，刷新 cookie 再试
      if (res.json) return res
      if (attempt + 1 < attempts) {
        logger.info(`[relay-checkin-plugin] anyrouter ${path} 返回非 JSON (HTTP ${res.status})，刷新 WAF cookie 重试`)
      } else {
        return {
          failed: `接口未返回有效数据 (HTTP ${res.status})`,
          uncertain: String(method).toUpperCase() === 'POST'
        }
      }
    }
    return { failed: WAF_MSG }
  },

  /**
   * 一次流程完成签到 + 用户信息查询（executor 优先调用）
   */
  async checkinWithInfo(account) {
    logger.info(`[relay-checkin-plugin] anyrouter 开始签到: ${account.name}`)
    const signPath = account.signPath || '/api/user/sign_in'
    // 先用只读请求验证/刷新 WAF cookie，同时记录余额供奖励兜底计算。
    const before = await this.apiCall(account, '/api/user/self')
    const beforeInfo = before.failed ? { ok: false, msg: before.failed } : parseUserInfo(before.json)
    let sign
    try {
      sign = await this.apiCall(account, signPath, 'POST')
    } catch (err) {
      sign = { failed: err.message, uncertain: true }
    }
    const self = await this.apiCall(account, '/api/user/self')
    const info = self.failed ? { ok: false, msg: self.failed } : parseUserInfo(self.json)
    const derivedAward = deriveAwardQuota(beforeInfo, info)
    let checkin
    if (sign.failed) {
      checkin = derivedAward != null
        ? { ok: true, already: false, confirmed: true, awardQuota: derivedAward, statusTextOverride: '余额复核成功', msg: '' }
        : { ok: false, already: false, uncertain: sign.uncertain, msg: sign.failed }
    } else {
      checkin = parseCheckinResult(sign.status, sign.json, sign)
      if (checkin.ok && !checkin.already && checkin.awardQuota == null && derivedAward != null) {
        checkin.awardQuota = derivedAward
      }
    }
    return { checkin, info }
  },

  async checkin(account) {
    const { checkin } = await this.checkinWithInfo(account)
    return checkin
  },

  async userInfo(account, { allowBrowser = true } = {}) {
    const fallback = allowBrowser ? '走浏览器取 WAF cookie' : '本次不打开浏览器'
    // 先快速试一次纯 HTTP（个别镜像站无 WAF，或缓存 cookie 已够用）
    const cached = getCached(new URL(account.baseUrl).hostname)
    try {
      const { status, json } = await request(`${account.baseUrl}/api/user/self`, {
        headers: this.buildHeaders(account, cached),
        timeoutMs: 8000,
        maxRetry: 0
      })
      if (json?.success) return parseUserInfo(json)
      logger.info(`[relay-checkin-plugin] anyrouter 纯 HTTP 探测未通过 (HTTP ${status}${json ? `, message=${json.message || '无'}` : ', 非 JSON 响应'})，${fallback}`)
    } catch (err) {
      logger.info(`[relay-checkin-plugin] anyrouter 纯 HTTP 探测失败（${err.message}），${fallback}`)
    }

    if (!allowBrowser) return { ok: false, msg: '余额查询需要网页验证，本次不打开浏览器' }
    const res = await this.apiCall(account, '/api/user/self')
    if (res.failed) return { ok: false, msg: res.failed }
    return parseUserInfo(res.json)
  }
}
