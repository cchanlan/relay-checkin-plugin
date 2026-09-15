import { matchSkipHost } from './checkin-policy.js'
import { getAdapter } from './adapters/index.js'
import { quotaToUsd, request, parseCheckinResult, classifyValidation, deriveAwardQuota, proxySetupHint, hostOf } from './adapters/common.js'
import { powCheckin, turnstileCheckin } from './browser.js'
import { ocrCaptcha } from './ocr.js'
import { getConfig } from './config.js'
import { accountLabel, persist } from './store.js'
import { logger } from '../host/index.js'
import { claimDailyLottery } from './daily-lottery.js'
import { formatTimes } from './adapters/mint.js'

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/**
 * 落盘失败（磁盘满、Windows 文件被占用等）只记日志：
 * 签到结果本身已在内存，不能因缓存落盘失败让整轮任务中断
 */
function safePersist() {
  try {
    persist()
  } catch (err) {
    logger.error(`[relay-checkin-plugin] 状态缓存落盘失败: ${err?.message || err}`)
  }
}

export const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min

export { matchSkipHost } from './checkin-policy.js'

const STATUS_TEXT = { ok: '签到成功', already: '今日已签', unknown: '签到未确认', fail: '签到失败' }

/**
 * 站点回复是否属于「需要人机验证」类拦截（应降级到浏览器方案重试）：
 * 仅匹配明确的人机验证提示。网页 X-Game-* 完整性标记由 NewAPI 适配器单独处理，
 * 不能把所有「完整性 / 请刷新」错误误报成 Turnstile。
 */
function needsBrowser(msg) {
  return /turnstile|人机|验证码|captcha|访问验证|checking your browser|安全验证|verification_required|pow[_ -]?shield|proof.?of.?work/i.test(String(msg || ''))
}

/**
 * 决定失败结果要不要降级到别的验证方案，以及降级到哪一种。
 *
 * 抽成纯函数是为了能单测：三条降级分支要么开浏览器、要么打站点接口，测试里跑不动，
 * 而「该不该降级」这个判断本身正是最容易出错的地方。
 *
 * @param {object} r 适配器返回的结果
 * @param {string} validation 已归类的验证类型（turnstile / pow / captcha / cfBlock / waf ...）
 * @returns {'captcha'|'pow'|'cfBlock'|'turnstile'|null} null 表示不降级，保留原结果与原文案
 */
export function pickValidationFallback(r, { validation, browserEnabled, hasCheckinPath }) {
  if (!r || r.ok || !hasCheckinPath) return null
  // 适配器自己已经开过浏览器过码（如 Sub2API）：再降级只会拿 new-api 风格的接口
  // 白试一轮，还会用兜底文案覆盖掉适配器给出的真实原因
  if (r.browserTried === true) return null
  // 适配器点名了「这种验证方式插件还不会过」（如站点把签到验证换成 cap）：
  // 降级同样是白试一轮，还会把这句真实原因盖掉
  if (validation === 'unsupported') return null
  if (validation === 'captcha') return 'captcha'
  if (!browserEnabled) return null
  if (!validation && !needsBrowser(r.msg)) return null
  if (validation === 'pow' || /安全验证|pow[_ -]?shield|proof.?of.?work/i.test(r.msg || '')) return 'pow'
  if (validation === 'cfBlock') return 'cfBlock'
  // 其余需要人机交互的类型统一交给浏览器
  return 'turnstile'
}

/**
 * 图形验证码站点降级签到（NewAPI 魔改站常见流程）：
 * POST /api/user/checkin/captcha 取 captcha_id + 图片 → ddddocr 识别 → 带
 * captcha_id/captcha_answer 重新提交签到，答错自动换码重试。
 */
async function captchaFallback(account, adapter, checkinPath = adapter.checkinPath, maxAttempts = 15) {
  const headers = adapter.buildHeaders(account)
  const captchaUrl = new URL('/api/user/checkin/captcha', `${account.baseUrl}/`).toString()
  const checkinUrl = new URL(checkinPath, `${account.baseUrl}/`).toString()
  let lastMsg = ''

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const cap = await request(captchaUrl, { method: 'POST', headers })
    const captchaId = cap.json?.data?.captcha_id
    const image = cap.json?.data?.captcha_image
    if (!cap.json?.success || !captchaId || !image) {
      const msg = cap.json?.message || `HTTP ${cap.status}`
      const hint = /请打开网站/.test(String(msg)) ? '（该站签到接口只认网页会话，请改用 #中转添加cookie 地址 session值 用户ID 绑定）' : ''
      logger.warn(`[relay-checkin-plugin] ${account.name} 获取验证码失败：${msg}`)
      return { ok: false, already: false, validation: 'captcha', msg: `获取验证码失败：${msg}${hint}` }
    }

    let answer = ''
    try {
      answer = await ocrCaptcha(Buffer.from(image.replace(/^data:image\/\w+;base64,/, ''), 'base64'))
    } catch (err) {
      logger.warn(`[relay-checkin-plugin] ${account.name} 验证码识别异常：${err?.message || err}`)
      return { ok: false, already: false, validation: 'captcha', msg: `验证码识别失败：${err?.message || err}` }
    }
    if (!answer) {
      lastMsg = '验证码识别结果为空'
      continue
    }
    logger.warn(`[relay-checkin-plugin] ${account.name} 验证码识别：${answer}（第 ${attempt} 次）`)

    const res = await request(checkinUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({ captcha_id: captchaId, captcha_answer: answer })
    })
    const parsed = parseCheckinResult(res.status, res.json, res)
    if (parsed.ok || parsed.already) {
      logger.warn(`[relay-checkin-plugin] ${account.name} 验证码签到完成（第 ${attempt} 次尝试）`)
      return parsed
    }
    lastMsg = parsed.msg
    // 答错：站点侧验证码已作废，换新码重试
  }
  return { ok: false, already: false, validation: 'captcha', msg: `验证码自动识别未通过（已重试 ${maxAttempts} 次）：${lastMsg}` }
}

/**
 * Turnstile site key 是站点常量，但 /api/status 会被站点的防护层连带拦掉。
 * 取到过一次就记住（内存 + 账号字段落盘），别让一次拦截把签到路整条堵死。
 */
const siteKeyCache = new Map()

function rememberSiteKey(account, siteKey) {
  const host = new URL(account.baseUrl).hostname
  siteKeyCache.set(host, siteKey)
  if (account.turnstileSiteKey !== siteKey) {
    account.turnstileSiteKey = siteKey
    safePersist()
  }
}

function recallSiteKey(account) {
  const host = new URL(account.baseUrl).hostname
  return siteKeyCache.get(host) || account.turnstileSiteKey || null
}

/**
 * Turnstile 站点浏览器降级签到：取 site key → 页面内过挑战 → 带 token 重调签到接口
 */
async function turnstileFallback(account, adapter, checkinPath = adapter.checkinPath) {
  const headers = adapter.buildHeaders(account)
  let siteKey = null
  try {
    const { json } = await request(`${account.baseUrl}/api/status`, {
      headers
    })
    siteKey = json?.data?.turnstile_site_key || null
  } catch {
    // 取不到 site key 走下方统一失败
  }
  if (siteKey) {
    rememberSiteKey(account, siteKey)
  } else {
    siteKey = recallSiteKey(account)
    if (siteKey) {
      logger.warn(`[relay-checkin-plugin] ${account.name} 的 /api/status 取不到 site key，`
        + '改用上次记住的值继续验证')
    }
  }
  if (!siteKey) {
    return { ok: false, already: false, msg: '站点要求人机验证但无法获取 site key，无法自动签到' }
  }

  const res = await turnstileCheckin(account, {
    checkinPath,
    headers,
    validationHeaders: adapter.buildValidationHeaders?.(account) || headers,
    siteKey
  })
  if (res.turnstileFailed) {
    return { ok: false, already: false, msg: res.message || '人机验证未通过，请稍后重试' }
  }
  const parsed = parseCheckinResult(res.status, res.json, res)
  if (!parsed.ok && parsed.validation === 'turnstile') {
    // 走到这里说明 Cloudflare 已经签发了 token、请求也发出去了（res.status 是站点的回复），
    // 站点却仍判验证不通过。实测最常见的原因是本机出口 IP 被判成高风险：数据中心 IP
    // 拿到的 token 在站点侧校验一律不通过，同一套代码换成非数据中心出口后立刻放行。
    // 这种情况下手动点验证同样过不去，所以不要再把用户引向交互验证。
    const detail = res.json?.message || res.json?.msg || ''
    logger.warn(`[relay-checkin-plugin] ${account.name} 已提交 Turnstile 凭据但站点判定失败`
      + `（HTTP ${res.status}${detail ? `｜${detail}` : ''}）：多半是本机出口 IP 被判成高风险，`
      + '在 proxy.url 配置一个非数据中心出口后重试即可；站点的 site key 与 secret 不配对也是同样表现')
    parsed.msg = `${parsed.msg}，${proxySetupHint(res?.host || hostOf(account))}`
  }
  return parsed
}

/**
 * NewAPI POW-Shield 浏览器签到：挑战、计算和 POST 必须留在同一个页面上下文。
 */
async function powFallback(account, adapter, checkinPath = adapter.checkinPath) {
  const headers = adapter.buildHeaders(account)
  const res = await powCheckin(account, {
    checkinPath,
    headers,
    validationHeaders: adapter.buildValidationHeaders?.(account) || headers
  })
  if (res.powFailed) {
    return { ok: false, already: false, uncertain: Boolean(res.uncertain), validation: 'pow', msg: res.message || 'POW 安全验证未完成' }
  }
  return parseCheckinResult(res.status, res.json, res)
}

async function readCheckinStatus(adapter, account) {
  if (typeof adapter.getCheckinStatus !== 'function') return null
  try {
    return await adapter.getCheckinStatus(account)
  } catch (err) {
    logger.warn(`[relay-checkin-plugin] ${account.name} 签到状态查询失败: ${err?.message || err}`)
    return { supported: true, ok: false, msg: err?.message || String(err) }
  }
}

async function readUserInfo(adapter, account, options) {
  try {
    const info = await adapter.userInfo(account, options)
    return info?.ok ? info : null
  } catch {
    return null
  }
}

/**
 * 对单个账号执行签到，并顺带查询最新余额
 * @returns {Promise<{name, status, statusText, award, balance, msg}>}
 */
export async function checkinAccount(account) {
  const adapter = getAdapter(account.type)
  // 跳过签到和抽奖，但仍查询余额；不为查询启动浏览器过验证。
  if (matchSkipHost(account.name, getConfig().skip?.hosts)) {
    logger.info(`[relay-checkin-plugin] ${account.name} 命中跳过清单，仅查询余额`)
    const info = await readUserInfo(adapter, account, { allowBrowser: false })
    const balance = info?.balanceText && info.balanceText !== '-' ? info.balanceText : null
    if (balance) account.lastBalance = balance
    const cached = account.lastBalance && account.lastBalance !== '-' ? account.lastBalance : null
    // 跳过不是实际完成签到：保留原签到日期、确认状态，只更新余额缓存。
    return {
      name: accountLabel(account),
      status: 'ok',
      statusText: '跳过签到',
      award: '',
      balance: balance || (cached ? `${cached}（缓存）` : '-'),
      msg: '不支持该站点'
    }
  }
  let r = null
  let beforeStatus = null
  let beforeInfo = null
  let afterInfo = null

  try {
    beforeStatus = await readCheckinStatus(adapter, account)
    if (beforeStatus?.ok && beforeStatus.checked) {
      // 明确查到本轮执行前已经签到：跳过非幂等 POST。
      r = {
        ok: true,
        already: true,
        confirmed: true,
        awardQuota: beforeStatus.awardQuota ?? null,
        awardText: beforeStatus.awardText ?? null,
        statusTextOverride: '本轮前已签到',
        msg: ''
      }
    } else {
      const compareBalance = typeof adapter.compareBalance === 'function'
        ? adapter.compareBalance(account)
        : adapter.compareBalance
      if (compareBalance || (beforeStatus?.ok && beforeStatus.checked === false)) {
        beforeInfo = await readUserInfo(adapter, account)
      }

      if (adapter.checkinWithInfo) {
        // AnyRouter 系在同一套 WAF cookie 下完成前后余额查询与签到。
        const session = await adapter.checkinWithInfo(account)
        r = session.checkin
        if (session.info?.ok) afterInfo = session.info
      } else {
        try {
          r = await adapter.checkin(account)
          if (r.info?.ok) afterInfo = r.info
        } catch (err) {
          r = { ok: false, already: false, uncertain: true, msg: err?.message || String(err) }
        }
        // 站点要求人机验证且浏览器方案可用时，自动降级为浏览器签到
        const validation = r?.validation || classifyValidation({ message: r?.msg })
        const browserCheckinPath = account.signPath || adapter.checkinPath
        // 图形验证码：不依赖浏览器，直接取码识别后重提签到
        const fallback = pickValidationFallback(r, {
          validation,
          browserEnabled: getConfig().browser.enable,
          hasCheckinPath: Boolean(browserCheckinPath)
        })
        if (!r.ok && r.browserTried === true) {
          logger.info(`[relay-checkin-plugin] ${account.name} 适配器已用浏览器尝试过验证，跳过降级：${r.msg || '无原因'}`)
        }
        if (fallback === 'captcha') {
          logger.info(`[relay-checkin-plugin] ${account.name} 需图形验证码，尝试自动识别`)
          try {
            r = await captchaFallback(account, adapter, browserCheckinPath)
          } catch (err) {
            r = { ok: false, already: false, validation: 'captcha', msg: `验证码识别失败，请稍后重试` }
          }
        } else if (fallback) {
          if (fallback === 'pow') {
            logger.info(`[relay-checkin-plugin] ${account.name} 需 POW 安全验证，尝试浏览器方案`)
            try {
              r = await powFallback(account, adapter, browserCheckinPath)
            } catch (err) {
              r = { ok: false, already: false, validation: 'pow', msg: `安全验证失败，请稍后重试` }
            }
          } else if (fallback === 'cfBlock') {
            // 出口被站点的 Cloudflare 防火墙规则封了，真实浏览器同样是那张拦截页，
            // 开一轮浏览器只会白等到超时。保留 parseCheckinResult 给出的「配 proxy.url」提示。
            logger.warn(`[relay-checkin-plugin] ${account.name} 的请求被 Cloudflare 按网络出口拦截，`
              + '真实浏览器也过不去，已跳过浏览器方案；请在 proxy.url 配置代理并把该站域名加入 proxy.hosts')
          } else {
            // 其余需要人机交互的类型（turnstile、waf 等）统一交给浏览器：
            // 这里以前只认 validation === 'turnstile'，于是 waf 一类既进不了浏览器、
            // 又没有别的处理，直接落地成「请求被站点 WAF/人机验证拦截」的死路。
            logger.info(`[relay-checkin-plugin] ${account.name} 需人机验证，尝试浏览器方案`)
            r = await turnstileFallback(account, adapter, browserCheckinPath)
          }
        }
      }

      const afterStatus = beforeStatus?.supported === false
        ? null
        : await readCheckinStatus(adapter, account)
      if (afterStatus?.ok && afterStatus.checked) {
        const changedThisRun = beforeStatus?.ok && beforeStatus.checked === false
        if (!r.ok || r.already) {
          // 前面报过错却复核到已签，必须留一行：否则日志里只剩那条过码失败的 warn，
          // 而出图写着「状态复核成功」，排查的人会以为两边有一个在骗自己。
          if (!r.ok) {
            logger.info(`[relay-checkin-plugin] ${account.name} 签到请求报「${r.msg || '未知原因'}」，`
              + `但站点状态显示${changedThisRun ? '本次已签到成功' : '今日早已签到'}，按成功处理`)
          }
          r = {
            ok: true,
            already: !changedThisRun,
            confirmed: true,
            awardQuota: r.awardQuota ?? afterStatus.awardQuota ?? null,
            awardText: r.awardText ?? afterStatus.awardText ?? null,
            statusTextOverride: changedThisRun ? '状态复核成功' : '状态复核已签',
            msg: ''
          }
        } else {
          r.confirmed = true
          if (r.awardQuota == null) r.awardQuota = afterStatus.awardQuota ?? null
          if (r.awardText == null) r.awardText = afterStatus.awardText ?? null
        }
      } else if (r.uncertain && afterStatus?.ok && !afterStatus.checked) {
        r.msg = `${r.msg}；状态复核仍为未签到`
      }
    }
  } catch (err) {
    r = { ok: false, already: false, msg: err?.message || String(err) }
  }

  // 查询签到后余额；失败不影响已经确认的签到结果。
  if (!afterInfo) afterInfo = await readUserInfo(adapter, account)
  if (!r?.ok && r?.uncertain && adapter.reconcileByBalance) {
    const awardQuota = deriveAwardQuota(beforeInfo, afterInfo)
    if (awardQuota != null) {
      logger.info(`[relay-checkin-plugin] ${account.name} 签到请求报「${r.msg || '未知原因'}」，`
        + '但余额比签到前增加了，按成功处理')
      r = {
        ok: true,
        already: false,
        confirmed: true,
        awardQuota,
        statusTextOverride: '余额复核成功',
        msg: ''
      }
    }
  }
  return finalizeCheckinResult(account, r, { beforeInfo, afterInfo })
}

/**
 * 薄荷的签到接口本身就把转盘抽奖一起做了，结果里已经带着奖励次数与余额，
 * 因此不追加独立活动行，只把签到行的展示改成「次」为单位。
 */
function applyMintResult(account, r, result) {
  const mint = r.mint
  const total = [mint.awardQuota, mint.bonusQuota]
    .filter(value => typeof value === 'number' && Number.isFinite(value))
    .reduce((sum, value) => sum + value, 0)
  const times = formatTimes(total)
  if (times) result.award = `${r.already ? '今日 +' : '+'}${times} 次`
  if (mint.newBalance != null) {
    const balance = formatTimes(mint.newBalance)
    if (balance) result.balance = balance
  }
  // 批注只写用户看得懂的结果：爆大奖、抽到的档位、连签天数
  const notes = []
  if (mint.pityHit) notes.push('必出大奖')
  if (mint.label) notes.push(mint.label)
  if (mint.streakDays > 1) notes.push(`连签 ${mint.streakDays} 天`)
  if (notes.length) result.msg = notes.join('，')
  return result
}

/**
 * 成功行的批注是不是只在复述状态列。只认纯状态词，带了额外内容（奖励明细、
 * 「但缺少 xx 字段」这类提醒）的一律保留。
 */
function restatesStatus(msg) {
  const text = String(msg || '').replace(/[\s。！!、,，.]/g, '')
  return !text || /^(签到)?成功$|^今日已签到?$|^已签到$|^ok$|^success$/i.test(text)
}

/**
 * 把适配器结果整理成统一展示行，并更新账号运行状态。
 * AgentRouter 邮箱登录响应的 quota 可能是 0 占位值；登录后会用新 Session
 * 再查一次 /api/user/self，不能把登录响应余额直接用于结果图。
 */
export function finalizeCheckinResult(account, r, { beforeInfo = null, afterInfo = null } = {}) {
  const result = { name: accountLabel(account), status: 'fail', statusText: '', award: '', balance: '-', msg: '' }
  if (afterInfo?.balanceText) result.balance = afterInfo.balanceText
  else if (r?.balanceText) result.balance = r.balanceText

  // 有些站点（AgentRouter）没有签到状态接口，登录响应又恒报「已签到」，
  // 于是重复执行时会一次次报同一笔奖励。这类适配器用 verifyByBalance 声明
  // 「我的成功结论要用余额复核」：涨了才算本次新签，没涨就是今天早已签过。
  if (r?.ok && !r.already && r.verifyByBalance) {
    const gained = deriveAwardQuota(beforeInfo, afterInfo)
    const comparable = beforeInfo?.ok === true && afterInfo?.ok === true
    if (gained != null) {
      r.awardQuota = gained
    } else if (comparable) {
      r.already = true
      r.statusTextOverride = '今日已签（余额未变）'
      r.awardQuota = null
    } else if (r.awardQuota == null) {
      // 前后余额有一端查不到，无法判断；退回站点公告里的名义奖励
      r.awardQuota = r.awardQuotaFallback ?? null
    }
  }

  if (r?.ok && !r.already && r.awardQuota == null) {
    r.awardQuota = deriveAwardQuota(beforeInfo, afterInfo)
  }

  if (r?.ok) {
    result.status = r.confirmed === false ? 'unknown' : (r.already ? 'already' : 'ok')
    result.statusText = r.statusTextOverride || STATUS_TEXT[result.status]
    // 站点的 message 常常就是「签到成功」，与状态列一字不差，再占一行批注纯属噪音
    result.msg = restatesStatus(r.msg) ? '' : (r.msg || '')
    // Sub2API 等站点的奖励本身就是美元金额，由适配器直接给出文本，不走 quota 换算
    const value = r.awardText ?? (r.awardQuota != null ? (quotaToUsd(r.awardQuota) ?? r.awardQuota) : null)
    if (value != null) {
      result.award = r.already ? `今日 +${value}` : `+${value}`
    }
    // 组合展示汇总绿字奖励用：保留原始 quota，避免解析已格式化的金额字符串
    result.awardQuotaValue = r.awardText == null ? (r.awardQuota ?? null) : null
    // 薄荷的奖励单位是「次」而非美元，且签到响应自带转盘结果，单独渲染这一行
    if (r.mint) applyMintResult(account, r, result)
  } else {
    result.status = 'fail'
    result.statusText = STATUS_TEXT.fail
    result.msg = r?.msg || '签到失败'
  }

  // 缓存运行时状态供 #中转列表 展示（由调用方批量落盘）
  const now = new Date().toISOString()
  if (result.status === 'ok' || result.status === 'already') {
    account.lastCheckinAt = now
    account.lastCheckinAttemptAt = now
    account.lastCheckinConfirmed = true
  } else if (result.status === 'unknown') {
    account.lastCheckinAttemptAt = now
    account.lastCheckinConfirmed = false
  }
  if (result.balance !== '-') account.lastBalance = result.balance

  return result
}

/**
 * 一个账号的签到及每日抽奖，按执行顺序返回独立活动结果。
 * 展示时用 combineCheckinResults 归并到一条站点记录的批注里。
 * 签到先完成余额复核；抽奖仅更新余额，不写入签到日期或确认状态。
 * initialCheckin 用于绑定时已由适配器完成签到的账号，避免重复提交。
 */
export async function checkinAccountResults(account, { initialCheckin = null, info = null } = {}) {
  const skipped = matchSkipHost(account.name, getConfig().skip?.hosts)
  const row = initialCheckin && !skipped
    ? finalizeCheckinResult(account, initialCheckin, { afterInfo: info })
    : await checkinAccount(account)
  const rows = [row]
  const adapter = getAdapter(account.type)
  if (skipped || matchSkipHost(account.name, getConfig().skip?.hosts) || adapter.type !== 'newapi') return rows

  let lottery
  try {
    lottery = await claimDailyLottery(account, adapter.buildHeaders(account))
  } catch {
    // 抽奖属于独立活动，不能覆盖前面已完成的签到结果。
    lottery = { ok: false, msg: '无法处理抽奖结果，请到站点查看' }
  }
  if (!lottery) return rows
  const status = lottery.uncertain ? 'unknown' : (lottery.ok ? (lottery.already ? 'already' : 'ok') : 'fail')
  const statusTexts = { ok: '抽奖成功', already: '今日已抽', unknown: '抽奖未确认', fail: '抽奖失败' }
  const balance = lottery.balanceQuota == null ? '-' : (quotaToUsd(lottery.balanceQuota) || '-')
  const award = lottery.awardQuota == null || lottery.already
    ? ''
    : `${lottery.awardQuota < 0 ? '-' : '+'}${quotaToUsd(Math.abs(lottery.awardQuota))}`
  rows.push({
    name: `${accountLabel(account)} · 每日抽奖`,
    status,
    statusText: statusTexts[status],
    award,
    awardQuotaValue: award ? lottery.awardQuota : null,
    balance,
    msg: lottery.msg || ''
  })
  if (balance !== '-') account.lastBalance = balance
  return rows
}

/**
 * 一站一行：独立活动的结果与金额分列在批注中。
 * 不修改原活动结果，也不把抽奖金额并进签到奖励；余额显示最后一次已知值。
 */
export function combineCheckinResults(rows) {
  const [checkin, ...activities] = rows
  if (!checkin || !activities.length) return checkin
  const describe = (label, result) => `${label}：${result.statusText}`
    + (result.award ? `，${result.award}` : '')
    + (result.msg && result.msg !== result.statusText ? `；${result.msg}` : '')
  const balance = [...activities].reverse().find(result => result.balance && result.balance !== '-')?.balance
  const combined = {
    ...checkin,
    balance: balance || checkin.balance,
    msg: [describe('签到', checkin), ...activities.map(result => describe('每日抽奖', result))].join('\n')
  }
  // 绿字奖励合并本轮签到与抽奖所得（批注仍分列明细）；「今日」前缀沿用签到状态
  const quotaGains = [checkin.awardQuotaValue, ...activities.map(result => result.awardQuotaValue)]
    .filter(value => typeof value === 'number' && Number.isFinite(value))
  if (quotaGains.length) {
    const total = quotaGains.reduce((sum, value) => sum + value, 0)
    const value = quotaToUsd(Math.abs(total)) ?? Math.abs(total)
    combined.award = `${checkin.status === 'already' ? '今日 ' : ''}${total < 0 ? '-' : '+'}${value}`
  }
  return combined
}

/**
 * 对一个用户条目的全部（或指定序号）账号执行签到
 * @param {object} entry 存储条目
 * @param {object} opts { index: 1起的序号(可选), delayRange: [min,max]秒(可选，账号间随机间隔),
 *                        autoOnly: 仅执行定时开关打开的账号（定时任务用） }
 */
export async function checkinEntry(entry, { index = null, delayRange = null, autoOnly = false } = {}) {
  let accounts = index ? [entry.accounts[index - 1]].filter(Boolean) : entry.accounts
  if (autoOnly) accounts = accounts.filter(acc => acc.auto !== false)
  const results = []
  for (let i = 0; i < accounts.length; i++) {
    if (i > 0 && delayRange) {
      await sleep(randInt(delayRange[0], delayRange[1]) * 1000)
    }
    results.push(combineCheckinResults(await checkinAccountResults(accounts[i])))
  }
  safePersist()
  return results
}

/**
 * 刷新条目内各账号的余额缓存（#中转列表 用）：
 * 纯 HTTP 站实时查询；AnyRouter 等浏览器站太慢，跳过用缓存。
 * 并发执行，单账号超时/失败保留旧缓存，不影响其他账号
 *
 * allowBrowser: false 会传给支持该选项的适配器（sub2api）：凭据过期时它本可以开浏览器
 * 重新过码登录（一两分钟），但这里 10 秒就超时了，被丢下的浏览器任务仍会占着全局页面
 * 槽位，把后续签到一起拖慢，所以列表刷新一律不许拉起浏览器。
 */
const BROWSER_TYPES = new Set(['anyrouter'])

export async function refreshBalances(entry, { timeoutMs = 10000 } = {}) {
  await Promise.allSettled(entry.accounts.map(async account => {
    if (BROWSER_TYPES.has(account.type)) return
    const adapter = getAdapter(account.type)
    let timer = null
    try {
      // 超时后原 promise 仍会被本 race 接管（不会变成未处理拒绝），同时清掉定时器避免悬挂
      const info = await Promise.race([
        adapter.userInfo(account, { allowBrowser: false }),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('刷新超时')), timeoutMs)
        })
      ])
      if (info.ok) {
        account.lastBalance = info.balanceText
        if (info.username) account.username = info.username
      }
    } finally {
      if (timer) clearTimeout(timer)
    }
  }))
  safePersist()
}

/**
 * 余额查询（不签到）
 * @returns {Promise<Array<{name, status, statusText, award, balance, msg}>>}
 */
export async function queryEntry(entry) {
  const results = []
  for (const account of entry.accounts) {
    const adapter = getAdapter(account.type)
    const row = { name: accountLabel(account), status: 'ok', statusText: '正常', award: '', balance: '-', msg: '' }
    try {
      const info = await adapter.userInfo(account)
      if (info.ok) {
        row.balance = info.balanceText
        row.award = `已用 ${info.usedText}`
        account.lastBalance = info.balanceText
      } else {
        row.status = 'fail'
        row.statusText = '查询失败'
        row.msg = info.msg
      }
    } catch (err) {
      row.status = 'fail'
      row.statusText = '查询失败'
      row.msg = err.message
    }
    results.push(row)
  }
  safePersist()
  return results
}
