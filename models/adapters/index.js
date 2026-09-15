import newapi from './newapi.js'
import veloera from './veloera.js'
import generic from './generic.js'
import agentrouter from './agentrouter.js'
import anyrouter from './anyrouter.js'
import sub2api from './sub2api.js'
import mint from './mint.js'
import { request } from './common.js'
import { normalizeAndValidateBaseUrl } from '../url-security.js'

const adapters = { newapi, veloera, generic, agentrouter, anyrouter, sub2api, mint }

export function getAdapter(type) {
  return adapters[type] || newapi
}

/**
 * Cookie 方式添加时按域名选择适配器
 * AgentRouter 官方域名：agentrouter.org 及 *.air-outer.com（如 ps.air-outer.com）
 * 薄荷公益站：up.x666.me（linux.do OAuth，只认 auth_token cookie）
 */
export function cookieTypeForHost(host) {
  if (/agentrouter|air-outer/i.test(host)) return 'agentrouter'
  if (/anyrouter/i.test(host)) return 'anyrouter'
  if (isMintHost(host)) return 'mint'
  return 'generic'
}

/**
 * 薄荷站域名判断。主站 up.x666.me 是签到面板；x666.me 是它的 api 站，
 * 两者共用同一套 auth_token，用户贴进来的地址以面板域名为主。
 */
export function isMintHost(host) {
  return /(^|\.)x666\.me$/i.test(String(host || ''))
}

/**
 * 需要专用凭据流程的站点：令牌入口不能正确完成 AnyRouter/AgentRouter 绑定。
 * 薄荷没有令牌与邮箱密码登录，只认 auth_token cookie，走令牌入口必然失败；
 * 普通 new-api/Veloera 站点返回 null，继续走令牌自动探测。
 */
export function preferredBindingForHost(host) {
  const type = cookieTypeForHost(host)
  if (type === 'anyrouter') return 'cookie'
  if (type === 'agentrouter') return 'email'
  if (type === 'mint') return 'cookie'
  return null
}

/**
 * 规范化站点地址：去尾部斜杠、补 https://
 */
export function normalizeBaseUrl(input) {
  return normalizeAndValidateBaseUrl(input)
}

/**
 * 识别 Sub2API 站点。它是自建程序、部署域名任意，
 * 无法像 AnyRouter/AgentRouter 那样按域名判断，只能问一次公开配置接口：
 * 该接口无需鉴权，返回 { code: 0, data: { site_name, turnstile_enabled, ... } }。
 * @returns {Promise<{ok: boolean, siteName?: string, turnstileEnabled?: boolean}>}
 */
export async function probeSub2apiSite(baseUrl) {
  try {
    const res = await request(`${baseUrl}/api/v1/settings/public`)
    const data = res.json?.data
    if (res.status !== 200 || res.json?.code !== 0 || !data) return { ok: false }
    // new-api 系没有这个接口路径，能取到这三个字段基本就能确定是 Sub2API
    if (typeof data.registration_enabled !== 'boolean' || !('turnstile_enabled' in data)) {
      return { ok: false }
    }
    return {
      ok: true,
      siteName: data.site_name || '',
      turnstileEnabled: data.turnstile_enabled === true
    }
  } catch {
    return { ok: false }
  }
}

/**
 * session Cookie 能否直接当 new-api 站点使用（如 jianzhile.vip 等
 * 签到接口要求网页会话的魔改站）。能则返回 newapi 会话账号探测结果。
 */
export async function probeSessionAccount(baseUrl, session, siteUserId) {
  const account = { baseUrl, token: session, siteUserId, authMode: 'session' }
  try {
    const info = await newapi.userInfo(account)
    if (info.ok) return { ok: true, type: 'newapi', info }
  } catch {
    // 非 new-api 站点走调用方的后续流程
  }
  return { ok: false }
}

/**
 * 自动探测站点类型（令牌方式添加时用）
 * 依次尝试 new-api（Bearer）、Veloera（原始令牌 + Veloera-User）
 * @returns {Promise<{ok: boolean, type?: string, info?: object, msg?: string}>}
 */
export async function probeAccount(baseUrl, token, siteUserId) {
  // 1) new-api：Bearer 令牌
  try {
    const info = await newapi.userInfo({ baseUrl, token, siteUserId })
    if (info.ok) {
      return { ok: true, type: 'newapi', info }
    }
  } catch (err) {
    return { ok: false, msg: err.message }
  }

  // 2) Veloera：需要站点用户ID
  if (siteUserId) {
    try {
      const info = await veloera.userInfo({ baseUrl, token, siteUserId })
      if (info.ok) {
        return { ok: true, type: 'veloera', info }
      }
    } catch {
      // 网络层失败在上一步已返回，这里静默进入最终失败
    }
  }

  return {
    ok: false,
    msg: siteUserId
      ? '令牌验证失败，请检查地址与令牌是否正确'
      : '令牌验证失败。若为 Veloera 站点，请在指令末尾附加站点用户ID重试'
  }
}
