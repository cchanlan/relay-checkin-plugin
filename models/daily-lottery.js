import { createHash } from 'node:crypto'
import { request } from './adapters/common.js'

const STATUS_PATH = '/api/site/welfare/status'
const LOTTERY_PATH = '/api/site/welfare/lottery'
const REQUEST_TIMEOUT_MS = 10000
const CAPABILITY_TTL_MS = 6 * 60 * 60 * 1000
const MAX_CACHED_SITES = 256
// 这里只缓存能力，不缓存某个用户今日是否已抽；临时网络错误不写负缓存。
const capabilities = new Map()

function rememberCapability(base, supported) {
  capabilities.delete(base)
  if (capabilities.size >= MAX_CACHED_SITES) capabilities.delete(capabilities.keys().next().value)
  capabilities.set(base, { supported, expiresAt: Date.now() + CAPABILITY_TTL_MS })
}

function quota(value) {
  if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) && Math.abs(parsed) <= Number.MAX_SAFE_INTEGER ? parsed : null
}

function doneFlag(lottery) {
  if (!lottery || typeof lottery !== 'object' || Array.isArray(lottery)) return null
  const flags = ['Done', 'done'].filter(key => Object.hasOwn(lottery, key)).map(key => lottery[key])
  if (!flags.length || flags.some(value => typeof value !== 'boolean' || value !== flags[0])) return null
  return flags[0]
}

async function reconcileLottery(base, options) {
  try {
    const status = await request(`${base}${STATUS_PATH}`, options)
    const data = status.json?.data
    if (status.status === 200 && status.json?.success === true && doneFlag(data?.daily_lottery) === true) {
      return {
        ok: true,
        balanceQuota: quota(data.quota),
        msg: '已复查今日抽奖完成，奖励金额以站点记录为准'
      }
    }
  } catch {
    // 不把状态查询失败当成领取失败，也不重发POST。
  }
  return { ok: false, uncertain: true, msg: '抽奖结果暂未确认，未重复提交，请到站点查看' }
}

/**
 * NewAPI 同源福利中心的每日抽奖。只接受明确的 daily_lottery 状态，
 * 不猜测接口，不调用可能扣余额的幸运签到或其他游戏。
 * 返回 null 表示未识别到该能力；领取状态每次向站点读取，不跨账号共享。
 */
async function executeLottery(account, headers) {
  const base = String(account.baseUrl || '').replace(/\/+$/, '')
  const cached = capabilities.get(base)
  if (cached?.supported === false && cached.expiresAt > Date.now()) return null
  const known = cached?.supported === true
  const unavailable = () => known ? { ok: false, msg: '暂时读不到每日抽奖状态，未发起抽奖' } : null
  const options = { headers, timeoutMs: REQUEST_TIMEOUT_MS, maxRetry: 0 }
  let status
  try {
    status = await request(`${base}${STATUS_PATH}`, options)
  } catch {
    return unavailable()
  }
  if ([404, 405, 410].includes(status.status)) {
    rememberCapability(base, false)
    return null
  }
  if (status.status !== 200 || status.json?.success !== true) return unavailable()
  const data = status.json?.data
  const lottery = data?.daily_lottery
  if (!lottery || typeof lottery !== 'object' || Array.isArray(lottery)) return unavailable()
  rememberCapability(base, true)
  const done = doneFlag(lottery)
  const balanceQuota = quota(data.quota)
  if (done === null) {
    return { ok: false, msg: '无法确认今日抽奖状态，未发起抽奖' }
  }
  if (done) return { ok: true, already: true, balanceQuota }
  const cost = lottery.cost_quota ?? lottery.CostQuota
  if (cost != null && quota(cost) !== 0) {
    return { ok: false, balanceQuota, msg: '站点提示抽奖需要扣除额度，已停止抽奖' }
  }

  let response
  try {
    // 与签到相同，领取 POST 不重试，避免响应丢失后重复领取。
    response = await request(`${base}${LOTTERY_PATH}`, { ...options, method: 'POST' })
  } catch {
    return await reconcileLottery(base, options)
  }
  if (response.status >= 200 && response.status < 300 && response.json?.success === true) {
    const reward = response.json.data || {}
    const awardQuota = quota(reward.net_quota)
    return {
      ok: true,
      awardQuota,
      balanceQuota: quota(reward.balance_quota),
      msg: awardQuota === null ? '抽奖已完成，奖励金额请到站点查看' : ''
    }
  }
  const message = String(response.json?.message || '')
  if (response.status === 200 && /今天已经抽奖过|今日已抽奖|今天已抽奖|already (?:drawn|claimed)/i.test(message)) {
    return { ok: true, already: true, msg: '' }
  }
  const unconfirmed = response.status >= 500 || response.status < 200
    || (response.status >= 300 && response.status < 400)
    || !response.json || typeof response.json.success !== 'boolean'
  if (unconfirmed) {
    return await reconcileLottery(base, options)
  }
  return { ok: false, msg: '每日抽奖未成功，请到站点查看后再试' }
}

// 跨聊天用户的同一站点账号也串行化；后来的调用重新查询状态，不重用先前的奖励。
const inFlight = new Map()

export async function claimDailyLottery(account, headers) {
  const base = String(account.baseUrl || '').replace(/\/+$/, '')
  const id = account.siteUserId == null || String(account.siteUserId) === ''
    ? `credential:${createHash('sha256').update(JSON.stringify([account.token || '', account.cookie || ''])).digest('hex')}`
    : `user:${account.siteUserId}`
  const key = `${base}|${id}`
  const previous = inFlight.get(key)
  const current = (previous ? previous.catch(() => {}) : Promise.resolve())
    .then(() => executeLottery(account, headers))
  inFlight.set(key, current)
  try {
    return await current
  } finally {
    if (inFlight.get(key) === current) inFlight.delete(key)
  }
}
