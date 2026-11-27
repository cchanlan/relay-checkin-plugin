import { request } from './common.js'
import { ensureCasaToken, casaRead, casaAuthFailed as authFailed, CASA_TOKEN_EXPIRED } from '../apikeycasa-auth.js'
import { APIKEY_CASA_AUTH_HINT, isApikeyCasaAuthToken } from '../apikeycasa-policy.js'

const CHECKIN_PATH = '/api/v1/redeem/checkin'
const AUTH_HINT = CASA_TOKEN_EXPIRED
const UNCERTAIN_HINT = '签到结果未确认，请刷新站点页面确认状态；不要连续重试'

function checkinUrl(account) {
  return `${String(account.baseUrl || '').replace(/\/+$/, '')}${CHECKIN_PATH}`
}


function moneyAmount(value) {
  if (!['number', 'string'].includes(typeof value) || String(value).trim() === '') return null
  const amount = Number(value)
  return Number.isFinite(amount) ? amount : null
}

function rewardAmount(value) {
  const amount = moneyAmount(value)
  return amount != null && amount >= 0 ? amount : null
}

function rewardText(amount) {
  // 站点金额本身是美元，不进 quotaToUsd；保留小额奖励，避免固定两位把它舍为零。
  return `$${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 8 })}`
}

function parseStatus(res) {
  if (res.authError) return { supported: true, ok: false, msg: res.authError }
  if (authFailed(res)) return { supported: true, ok: false, msg: AUTH_HINT }
  if (res.status < 200 || res.status >= 300 || res.json?.code !== 0) {
    // 不把任意站点 message 直接转发到结果图或日志，避免服务端回显凭据。
    return { supported: true, ok: false, msg: `签到状态查询失败（HTTP ${res.status}），请稍后重试` }
  }
  const data = res.json.data
  const reward = rewardAmount(data?.reward)
  if (typeof data?.checked_in !== 'boolean' || reward == null) {
    return { supported: true, ok: false, msg: '站点签到状态返回异常，请稍后重试' }
  }
  return {
    supported: true,
    ok: true,
    checked: data.checked_in,
    enabled: reward > 0,
    reward,
    awardQuota: null,
    awardText: data.checked_in ? rewardText(reward) : null,
    balanceQuota: null,
    balanceText: '-'
  }
}

export default {
  type: 'apikeycasa',
  label: 'apikey.casa',
  checkinPath: CHECKIN_PATH,

  buildHeaders(account) {
    return { Authorization: `Bearer ${(account.authMode === 'email' ? account.accessToken : account.token) || ''}` }
  },

  async login(account) {
    return ensureCasaToken(account)
  },

  async userInfo(account) {
    if (account.authMode !== 'email' && ((account.authMode && account.authMode !== 'token') || !isApikeyCasaAuthToken(account.token))) {
      return { ok: false, msg: APIKEY_CASA_AUTH_HINT }
    }
    // 个人信息接口提供真实美元余额；余额查询不依赖签到接口，也不触发签到。
    let res
    try {
      res = await casaRead(account, '/auth/me')
    } catch {
      return { ok: false, msg: '无法查询 apikey.casa 余额，请稍后重试' }
    }
    if (res.authError) return { ok: false, msg: res.authError }
    if (authFailed(res)) return { ok: false, msg: AUTH_HINT }
    if (res.status < 200 || res.status >= 300 || res.json?.code !== 0) {
      return { ok: false, msg: `余额查询失败（HTTP ${res.status}），请稍后重试` }
    }
    const data = res.json.data
    const balance = moneyAmount(data?.balance)
    if (balance == null) return { ok: false, msg: '站点余额返回异常，请稍后重试' }
    const id = moneyAmount(data?.id)
    return {
      ok: true,
      username: typeof data.username === 'string' ? data.username : '',
      siteUserId: Number.isSafeInteger(id) && id > 0 ? id : null,
      quota: null,
      usedQuota: null,
      // balance 本身就是美元；不转换 quota、不叠加奖励、不猜测冻结或已用金额。
      balanceText: `$${balance.toFixed(2)}`,
      usedText: '-',
      checkedIn: null
    }
  },

  async getCheckinStatus(account) {
    if (account.authMode !== 'email' && ((account.authMode && account.authMode !== 'token') || !isApikeyCasaAuthToken(account.token))) {
      return { supported: true, ok: false, msg: APIKEY_CASA_AUTH_HINT }
    }
    try {
      return parseStatus(await casaRead(account, '/redeem/checkin'))
    } catch {
      return { supported: true, ok: false, msg: '无法查询 apikey.casa 签到状态，请稍后重试' }
    }
  },

  async checkin(account) {
    // 执行器会先检查状态；直接调用适配器时也要保护，状态未知绝不提交。
    const status = await this.getCheckinStatus(account)
    if (!status.ok) return { ok: false, already: false, msg: status.msg }
    if (status.checked) {
      return { ok: true, already: true, confirmed: true, awardText: status.awardText, balanceText: '-' }
    }
    if (!status.enabled) return { ok: false, already: false, msg: '该站点暂未开启签到，请稍后再试' }

    let res
    try {
      // 公开前端的领取请求不带 body。连请求发出前的代理握手重试也显式关闭。
      res = await request(checkinUrl(account), {
        method: 'POST', headers: this.buildHeaders(account), maxRetry: 0, retryBeforeSend: false, sensitive: true
      })
    } catch {
      // 请求可能已在站点成功；交给执行器只读复核，不能重复领取。
      return { ok: true, already: false, confirmed: false, uncertain: true, msg: UNCERTAIN_HINT }
    }
    if (authFailed(res)) return { ok: false, already: false, msg: AUTH_HINT }
    const result = parseStatus(res)
    if (result.ok && result.checked) {
      return { ok: true, already: false, confirmed: true, awardText: result.awardText, balanceText: '-' }
    }
    if (res.json && res.json.code !== 0) {
      return { ok: false, already: false, msg: '站点未完成签到，请刷新站点页面确认状态后重试' }
    }
    return { ok: true, already: false, confirmed: false, uncertain: true, msg: UNCERTAIN_HINT }
  }
}
