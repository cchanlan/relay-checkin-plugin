import { request } from './common.js'

/**
 * 薄荷公益站（自研站，非 NewAPI）
 *
 * 接口前缀 /api，响应统一 { success: boolean, message?, ...字段平铺 }。
 * 鉴权只有一个 HttpOnly 的 auth_token cookie，登录入口是 linux.do OAuth：
 *   GET /api/auth/login → { auth_url }
 * 没有邮箱密码登录，也没有系统访问令牌，所以插件侧只能让用户自己登录后
 * 把 auth_token 贴进来（authMode: session）。
 *
 * 签到与转盘是同一个接口 POST /api/checkin/spin（无请求体），
 * 一次调用既完成签到又完成抽奖，所以本适配器把「签到结果」和「抽奖结果」
 * 合并成一条展示行，不再走 newapi 那条独立的 claimDailyLottery 通道。
 *
 * 奖池单位是「次」不是美元：/api/wheel/config 里 500 quota = 1 次，
 * 页面上的「余额 36,876 次」就是 current_quota / 500。用户看的是次数，
 * 所以这里把余额和奖励都换算成次数展示，不套 quotaToUsd。
 */

const QUOTA_PER_TIME = 500

/** 站点返回的 quota 换算成「次」，保留一位小数（里程碑奖励可能不是 500 的整数倍） */
export function timesFromQuota(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n === 0) return null
  return Math.round((n / QUOTA_PER_TIME) * 10) / 10
}

/** 千分位展示，与站点页面一致 */
export function formatTimes(value) {
  const times = timesFromQuota(value)
  if (times === null) return null
  return times.toLocaleString('en-US', { maximumFractionDigits: 1 })
}

export default {
  type: 'mint',
  label: '薄荷',
  // 签到接口自带抽奖，不支持独立的状态/抽奖查询，也不参与余额复核
  checkinPath: '/api/checkin/spin',

  buildHeaders(account) {
    return {
      // 站点认 Authorization: Bearer <值>，也认 Cookie: auth_token=<值>
      // （2026-09 实测：Bearer 200；Cookie 名必须是 auth_token，
      //  写成 sid / token / auth 一律 401「未提供认证信息」）
      Cookie: `auth_token=${account?.token || ''}`,
      Origin: 'https://up.x666.me',
      Referer: 'https://up.x666.me/',
      'Content-Type': 'application/json'
    }
  },

  async userInfo(account) {
    const base = String(account.baseUrl || '').replace(/\/+$/, '')
    const res = await request(`${base}/api/user/info`, {
      headers: this.buildHeaders(account)
    })
    const json = res.json
    if (res.status === 401 || json?.success === false) {
      return { ok: false, msg: json?.message || '凭据无效或已过期' }
    }
    if (res.status !== 200 || json?.success !== true) {
      return { ok: false, msg: json?.message || `获取用户信息失败 (HTTP ${res.status})` }
    }
    // /api/user/info 只给身份，不给余额；余额在 /api/checkin/status 的
    // current_quota（2026-09 实测），拿不到就留空，别硬塞 '-'
    let balanceText = ''
    try {
      const st = await request(`${base}/api/checkin/status`, {
        headers: this.buildHeaders(account)
      })
      if (st.status === 200 && st.json?.success === true) {
        balanceText = formatTimes(st.json.current_quota) || ''
      }
    } catch { /* 余额是附加信息，失败不影响绑定 */ }
    return {
      ok: true,
      username: json.username || '',
      siteUserId: json.linux_do_id ?? json.id ?? null,
      balanceText,
      usedText: '',
      checkedIn: null
    }
  },

  /** 签到前读一次：can_spin=false 表示今天已经抽过 */
  async getCheckinStatus(account) {
    const base = String(account.baseUrl || '').replace(/\/+$/, '')
    const res = await request(`${base}/api/checkin/status`, {
      headers: this.buildHeaders(account)
    })
    if (res.status === 401) {
      return { supported: true, ok: false, msg: res.json?.message || '凭据无效或已过期' }
    }
    if (res.status === 404) return { supported: false }
    const json = res.json
    if (res.status !== 200 || json?.success !== true || typeof json.can_spin !== 'boolean') {
      return { supported: true, ok: false, msg: json?.message || `签到状态查询失败 (HTTP ${res.status})` }
    }
    return {
      supported: true,
      ok: true,
      checked: json.can_spin === false,
      awardQuota: null,
      balanceQuota: json.current_quota ?? null,
      luck: json
    }
  },

  async checkin(account) {
    const base = String(account.baseUrl || '').replace(/\/+$/, '')
    const res = await request(`${base}/api/checkin/spin`, {
      method: 'POST',
      headers: this.buildHeaders(account)
    })
    const json = res.json
    if (res.status === 401) {
      return { ok: false, already: false, msg: 'auth_token 已失效，请重新登录后贴新的 auth_token' }
    }
    if (res.status === 404) {
      return { ok: false, already: false, msg: '站点无此签到接口（可能未启用签到功能）' }
    }
    if (json?.success === true) {
      return { ok: true, already: false, mint: parseSpin(json) }
    }
    const message = String(json?.message || '')
    // 站点在已抽过时返回 success=false + 含「已签到」的 message（前端据此把按钮置为成功态）
    if (/已签到|已抽|已经抽|重复/i.test(message)) {
      return { ok: true, already: true, msg: '' }
    }
    return { ok: false, already: false, msg: message || `签到失败 (HTTP ${res.status})` }
  }
}

/**
 * 解析 /api/checkin/spin 的成功响应。
 * 真实字段（2026-09 实测）：success / level / quota / label / pity_hit /
 * milestone_bonus / streak_days / new_balance / today_rank / month_days
 */
export function parseSpin(json) {
  const award = Number(json?.quota)
  const bonus = Number(json?.milestone_bonus)
  return {
    label: json?.label || '',
    level: json?.level ?? null,
    awardQuota: Number.isFinite(award) ? award : null,
    // 里程碑额外奖励单独记，展示时合并进总额
    bonusQuota: Number.isFinite(bonus) && bonus > 0 ? bonus : null,
    // pity_hit 为 1 或 2 表示本轮触发了必出大奖
    pityHit: json?.pity_hit === 1 || json?.pity_hit === 2,
    streakDays: Number.isFinite(Number(json?.streak_days)) ? Number(json.streak_days) : null,
    todayRank: Number.isFinite(Number(json?.today_rank)) ? Number(json.today_rank) : null,
    monthDays: Number.isFinite(Number(json?.month_days)) ? Number(json.month_days) : null,
    newBalance: Number.isFinite(Number(json?.new_balance)) ? Number(json.new_balance) : null
  }
}
