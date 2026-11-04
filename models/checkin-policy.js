/**
 * 检查账号名是否命中跳过清单（纯函数便于测试）
 * accountName 通常为站点 host；skipHosts 按包含匹配，规则与 proxy.hosts 相同
 */
export function matchSkipHost(accountName, skipHosts) {
  if (!Array.isArray(skipHosts) || !skipHosts.length) return false
  return skipHosts.some(h => h && String(accountName).includes(String(h)))
}

/** ChatflowsAI 的签到页独立于 Sub2API 标准接口，按真实域名匹配。 */
export function isChatflows(account) {
  try { return new URL(account.baseUrl).hostname === 'ai.chatflowsai.com' } catch { return false }
}

// 宿主 cron 只负责唤醒，日期与时刻统一按北京时间计算，不依赖系统时区。
export const SITE_CHECKIN_CRON = '0 * * * * *'
export const SITE_CHECKIN_TASK_NAME = '中转站午后签到'

export function beijingClock(now = Date.now()) {
  const date = new Date(Number(now) + 8 * 60 * 60 * 1000)
  return { day: date.toISOString().slice(0, 10), minutes: date.getUTCHours() * 60 + date.getUTCMinutes() }
}

export function shouldScheduleAccount(account, { siteOnly = false, now = Date.now() } = {}) {
  if (account.auto === false) return false
  if (!siteOnly) return !isChatflows(account)
  if (!isChatflows(account)) return false
  const { day, minutes } = beijingClock(now)
  if (minutes < 12 * 60 + 10 || account.lastSiteAutoDay === day) return false
  const signedAt = Date.parse(account.lastCheckinAt)
  if (account.lastCheckinConfirmed === true && Number.isFinite(signedAt) && signedAt <= Number(now)) {
    const signed = beijingClock(signedAt)
    if (signed.day === day && signed.minutes >= 12 * 60) return false
  }
  return true
}
