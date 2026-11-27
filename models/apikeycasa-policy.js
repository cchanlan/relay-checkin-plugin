/** apikey.casa 使用专用邮箱登录或网页 Auth token，不进入通用签到探测。 */
export const APIKEY_CASA_AUTH_HINT = 'apikey.casa 支持邮箱密码自动登录或 Auth token 绑定，不接受 Cookie、单独刷新令牌或 API Key。\n请优先私聊发送：#中转添加邮箱 apikey.casa\n'
  + '如需手动绑定 Auth token：先在浏览器登录 apikey.casa，按 F12 → Network，刷新签到页面，打开 /api/v1/redeem/checkin 请求，'
  + '复制 Authorization 中 Bearer 后面的值（不要带 Bearer 前缀），然后私聊发送：\n'
  + '#中转添加 https://apikey.casa AuthToken值'

export function isApikeyCasaHost(host) {
  return String(host || '').toLowerCase().replace(/\.$/, '') === 'apikey.casa'
}

export function isApikeyCasaSite(site) {
  try {
    const url = site?.baseUrl || (site?.host ? `https://${site.host}` : '')
    return isApikeyCasaHost(new URL(url).hostname)
  } catch { return false }
}

export function bindingRestrictionForSite(site, kind) {
  return isApikeyCasaSite(site) && !['token', 'email'].includes(kind) ? APIKEY_CASA_AUTH_HINT : null
}

/** 仅做凭据种类的快速拒绝；是否有效始终由站点鉴权接口决定，不能信任解码内容。 */
export function isApikeyCasaAuthToken(token) {
  return typeof token === 'string' && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)
}
