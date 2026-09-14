import { getConfig } from '../models/config.js'
import { touchEntry, upsertAccount, removeAccount, setAuto, setAccountAuto, accountLabel, persist, setPushGroup, rememberGroup } from '../models/store.js'
import { probeAccount, probeSessionAccount, probeSub2apiSite, normalizeBaseUrl, getAdapter, cookieTypeForHost, preferredBindingForHost } from '../models/adapters/index.js'
import { checkinEntry, checkinAccountResults, combineCheckinResults, queryEntry, refreshBalances } from '../models/executor.js'
import { withUserLock } from '../models/lock.js'
import { renderResult, renderList, renderHelp, formatResultRows } from '../models/render.js'
import { browserHangBudgetMs } from '../models/browser.js'
import { logger, pickBot, segment, defaultSelfId } from '../host/index.js'

/**
 * 等待私聊补发凭据的绑定会话（key: QQ号字符串）
 * { kind: 'token'|'cookie'|'email', baseUrl, host, userId, selfId, groupId, messageId,
 *   timer, promptMsgId, promptTimer }
 * groupId/messageId 记录发起流程的群与指令消息，绑定结束后引用该消息回执结果；
 * promptMsgId 为群内「请私聊发送凭据」提示消息，绑定终态时立即撤回，否则到时撤回
 */
const pendingBinds = new Map()
const BIND_SCOPE_NOTICE = '授权说明：凭据会保存在机器人本地，仅用于账号验证、余额查询和自动签到；请只绑定可信站点。'

function clearPending(userId) {
  const pending = pendingBinds.get(String(userId))
  if (pending) {
    clearTimeout(pending.timer)
    if (pending.promptTimer) clearTimeout(pending.promptTimer)
    pendingBinds.delete(String(userId))
  }
  return pending
}

/**
 * 清空所有等待中的绑定会话
 *
 * NG 卸载插件时调用：pendingBinds 里挂着超时定时器与群提示撤回定时器，
 * 不收掉就会在插件已经卸载之后继续开火（去调一个不存在的 Bot）
 */
export function disposeBinds() {
  for (const userId of [...pendingBinds.keys()]) clearPending(userId)
}

/**
 * 布设（或重置）绑定会话的超时定时器：超时后取消会话并两端回执
 */
function armBindTimeout(pending, timeoutSec) {
  if (pending.timer) clearTimeout(pending.timer)
  pending.timer = setTimeout(async () => {
    pendingBinds.delete(pending.userId)
    await recallBindPrompt(pending)
    await notifyBindPrivate(pending, `中转站 ${pending.host} 绑定超时，已取消，可重新发送添加指令`)
    await notifyBindGroup(pending, `中转站 ${pending.host} 绑定超时，已取消`)
  }, timeoutSec * 1000)
}

/**
 * 撤回群内的绑定提示消息（终态立即调用；定时器到期兜底调用，重复调用无副作用）
 */
async function recallBindPrompt(pending) {
  if (!pending?.promptMsgId || !pending.groupId) return
  const msgId = pending.promptMsgId
  pending.promptMsgId = null
  if (pending.promptTimer) {
    clearTimeout(pending.promptTimer)
    pending.promptTimer = null
  }
  try {
    const bot = pickBot(pending.selfId)
    if (bot) await bot.recallGroupMsg(pending.groupId, msgId)
  } catch {
    // 已被撤回或超过撤回时限，忽略
  }
}

/**
 * 取消息的原始文本：Yunzai 核心会把 e.msg 开头的 / ＃ 井 \ * 等字符归一化，
 * 以这些字符开头的凭据（如 base64 令牌以 / 开头）会被改坏，
 * 解析凭据一律走原始消息段
 */
function rawText(e) {
  if (Array.isArray(e.message)) {
    const t = e.message.filter(s => s.type === 'text').map(s => s.text ?? '').join('').trim()
    if (t) return t
  }
  return String(e.raw_message ?? e.msg ?? '').trim()
}

/**
 * 邮箱绑定要填的密码措辞：AgentRouter 特指「站内密码」（易与 GitHub/LinuxDO 混淆），
 * 其他走邮箱绑定的站点（Sub2API）就是普通登录密码。
 */
function emailPasswordLabel(site) {
  return cookieTypeForHost(site?.host) === 'agentrouter' ? 'AgentRouter站内密码' : '登录密码'
}

function specializedBindingHint(site) {
  const kind = preferredBindingForHost(site?.host)
  if (kind === 'cookie') {
    return `检测到 ${site.host} 是 AnyRouter，请不要使用“#中转添加 令牌”。请改用：\n#中转添加cookie ${site.baseUrl}\n随后私聊发送：session值 用户ID`
  }
  if (kind === 'email') {
    return `检测到 ${site.host} 是 AgentRouter，普通令牌不能用于自动签到。请改用：\n#中转添加邮箱 ${site.baseUrl}\n随后私聊发送：邮箱 AgentRouter站内密码`
  }
  return null
}

function agentRouterCookieHint(site) {
  if (preferredBindingForHost(site?.host) !== 'email') return null
  return `检测到 ${site.host} 是 AgentRouter，Cookie 只能查询余额，不能自动领取每日 $25。请改用：\n#中转添加邮箱 ${site.baseUrl}\n随后私聊发送：邮箱 AgentRouter站内密码`
}

/**
 * 按账号数量与类型生成签到等待提示：账号多或含需过 WAF/人机验证的站点时
 * 明确告知预计耗时，避免用户以为卡死而重复发指令
 */
function progressTip(accounts) {
  const total = accounts.length
  if (total <= 1) return '正在签到，请稍候...'

  // 浏览器方案站点（过 WAF / 人机验证）单个约 30~60 秒，普通 API 站约 1~3 秒。
  // Sub2API 在 access_token 与 refresh_token 都失效时也要开浏览器过 Turnstile 重登，
  // 且它的可见过码额度就是 120 秒，漏算会把预计耗时报得远低于实际
  const heavy = accounts.filter(acc => acc.type === 'anyrouter' || acc.type === 'sub2api').length
  const estSec = heavy * 45 + (total - heavy) * 3
  const estText = estSec >= 60 ? `约 ${Math.ceil(estSec / 60)} 分钟` : `约 ${Math.max(5, Math.ceil(estSec / 5) * 5)} 秒`
  let tip = `正在为你的 ${total} 个账号依次签到，预计${estText}，完成后统一出图，请勿重复发送指令`
  if (heavy > 0) {
    tip += `\n（部分站点耗时较长，属正常）`
  }
  return tip
}

/**
 * 兜底防挂起：验证/签到流程无论卡在哪一层，都给出明确失败而不是永久静默。
 * 预算必须大于当前浏览器阶段「排队等空闲 + 浏览器执行」的上限，否则会出现「已告知用户超时失败、
 * 任务稍后拿到槽位却真的签到了」的自相矛盾结果
 */
function hangBudgetMs() {
  try {
    return browserHangBudgetMs(getConfig().browser)
  } catch {
    // 取配置失败（如 data 目录不可写）不能让调用方同步抛出：
    // 那会导致已在飞行的请求 promise 无人接管，触发 unhandledRejection 退进程
    return 540000
  }
}

function guardHang(promise, label, ms = hangBudgetMs()) {
  let timer = null
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        logger.error(`[relay-checkin-plugin] ${label} 超时（${ms / 1000}s），已停止等待结果`)
        reject(new Error(`${label}超时，请稍后重试`))
      }, ms)
    })
  ])
}

/**
 * 群内绑定提示/回执的自动撤回秒数（防多人使用刷屏；QQ 限制只能撤回 2 分钟内自己的消息）
 */
function bindRecallSec() {
  const sec = getConfig().bind.groupRecallSec ?? 60
  return sec > 0 ? Math.min(sec, 120) : 0
}

/**
 * 绑定结果回执到发起流程的群（引用原指令消息，只含非敏感信息）。
 * 成功绑定可传入结果图片，此时不再安排自动撤回；文本回执仍按原配置撤回。
 */
async function notifyBindGroup(pending, text, image = null) {
  if (!pending?.groupId) return
  try {
    const bot = pickBot(pending.selfId)
    if (!bot) return
    const seg = segment()
    const message = [
      seg.reply(pending.messageId),
      seg.at(pending.userId)
    ]
    if (image) message.push(image)
    else message.push(' ' + text)
    const res = await bot.sendGroup(pending.groupId, message)
    const sec = bindRecallSec()
    if (!image && sec > 0 && res?.message_id) {
      setTimeout(async () => {
        try {
          await bot.recallGroupMsg(pending.groupId, res.message_id)
        } catch {
          // 超过撤回时限等情况，忽略
        }
      }, sec * 1000)
    }
  } catch (err) {
    logger.error(`[relay-checkin-plugin] 群 ${pending.groupId} 绑定回执失败: ${err?.message || err}`)
  }
}

async function notifyBindPrivate(pending, text) {
  try {
    const bot = pickBot(pending.selfId)
    if (!bot) return
    await bot.sendPrivate(pending.userId, text)
  } catch {
    // 非好友等场景私聊发不出去，忽略（群回执兜底）
  }
}

/**
 * TRSS 的 disablePrivate 是 priority -Infinity 的系统插件：开启后非主人的私聊消息
 * 在进入本插件前即被拦截，仅放行含 disableAdopt「通行字符串」的消息（主人不受限）。
 * 返回 null = 私聊不受限；{ passable } = 「中转绑定 凭据」能否靠通行字符串放行
 */
async function getPrivateBlock(e) {
  if (e.isMaster) return null
  let other
  try {
    other = (await import('../../../lib/config/config.js')).default?.other
  } catch {
    return null // 非 Yunzai 环境（如独立测试）无此配置
  }
  if (!other?.disablePrivate) return null
  const adopt = (Array.isArray(other.disableAdopt) ? other.disableAdopt : [])
    .filter(s => s != null && s !== '')
  return { passable: adopt.some(s => '中转绑定'.includes(String(s)) || '中转站绑定'.includes(String(s))) }
}

/**
 * 指令表：触发正则 → 处理方法名。TRSS 与 NG 两个入口共用这一份
 * （TRSS 把它铺成 plugin 的 rule，NG 铺成 ctx.command）。
 * fallback 标记的是「命中任意消息」的兜底规则，NG 侧要额外给它设成不阻断后续命令。
 */
export const COMMAND_RULES = [
  { reg: '^#中转(?:站)?(帮助|help)$', fnc: 'help', desc: '中转站签到帮助图' },
  { reg: '^#中转(?:站)?添加邮箱\\s+\\S+(?:\\s+\\S+)*$', fnc: 'addEmail', desc: '邮箱登录绑定（AgentRouter / Sub2API）' },
  // 与「添加」规则互不冲突（那条要求 添加 后紧跟空格），仍与同族指令排在一起便于维护
  { reg: '^#中转(?:站)?添加刷新令牌\\s+\\S+(?:\\s+\\S+)*$', fnc: 'addRefresh', desc: '刷新令牌绑定（Sub2API）' },
  { reg: '^#中转(?:站)?添加[cC]ookie\\s+\\S+(?:\\s+\\S+)*$', fnc: 'addCookie', desc: 'Cookie 绑定（AnyRouter / 旧版站点）' },
  { reg: '^#中转(?:站)?添加\\s+\\S+(?:\\s+\\S+)*$', fnc: 'add', desc: '令牌绑定，自动识别站点类型' },
  { reg: '^#中转(?:站)?列表$', fnc: 'list', desc: '我的账号列表' },
  { reg: '^#中转(?:站)?删除\\s*(\\d+)$', fnc: 'remove', desc: '删除指定序号的账号' },
  { reg: '^#中转(?:站)?签到\\s*(\\d+)?$', fnc: 'checkin', desc: '立即签到全部或指定账号' },
  { reg: '^#中转(?:站)?查询$', fnc: 'query', desc: '查询余额' },
  { reg: '^#中转(?:站)?定时\\s*(开|关)\\s*(\\d+)?$', fnc: 'toggleAuto', desc: '定时签到开关' },
  { reg: '^#中转(?:站)?(开启|关闭)(定时(签到)?)?群推送$', fnc: 'togglePushGroup', desc: '把本群加入/移出定时推送目标' },
  // 私聊补发凭据兜底：命中任意消息，处理器按原始文本与绑定会话判断是否消费
  // （不能按首字符过滤：/ 开头的令牌会被核心归一化，规则层看不到原字符）
  { reg: '^[\\s\\S]+$', fnc: 'bindCredentials', log: false, fallback: true, desc: '私聊补发凭据（兜底，不出现在帮助里）' }
]

/** 定时签到任务名（两个宿主的任务列表都用它） */
export const CHECKIN_TASK_NAME = '中转站定时签到'

/**
 * 指令处理主体
 *
 * 原来这是个 `extends plugin` 的 TRSS 插件类。为了同时给 Yunzai NG 用，
 * 改成不继承任何宿主基类：宿主入口负责把消息事件与回复函数注入进来，
 * 类体内部照旧用 `this.e` 与 `this.reply(...)`，因此 1100 行指令逻辑无需改动。
 */
export class RelayCheckinCore {
  /** 由入口注入的回复函数 */
  #reply

  /**
   * @param {{e: object, reply: Function}} deps e 为 TRSS 形状的消息事件
   *   （NG 侧由 ng/event.js 把内核事件包成同一形状），reply 为回复函数
   */
  constructor({ e, reply }) {
    this.e = e
    this.#reply = reply
  }

  /**
   * 回复消息，签名沿用 TRSS：reply(内容, 是否引用, { recallMsg, at })
   */
  async reply(...args) {
    return await this.#reply(...args)
  }

  /**
   * 群里发含令牌的指令后尝试撤回，减少泄露
   */
  async recallIfGroup() {
    if (!this.e.isGroup || !getConfig().recallAdd) return
    try {
      await this.e.group.recallMsg(this.e.message_id)
    } catch {
      // 无管理员权限时撤回失败，忽略
    }
  }

  /**
   * 加用户锁执行：同一用户的耗时操作串行，重复触发时提示而不是并发执行
   */
  async runLocked(label, fn) {
    let r
    try {
      r = await withUserLock(this.e.user_id, label, fn)
    } catch (err) {
      // 未预见的异常（如落盘失败）也要给用户回执，否则表现为「发了指令没反应」
      logger.error(`[relay-checkin-plugin] ${label} 执行异常:`, err)
      await this.reply(`${label}出错了，请稍后重试`)
      return false
    }
    if (!r.ok) {
      await this.reply(`你的「${r.busy.label}」正在进行中（已 ${r.busy.seconds} 秒），请等它完成后再试`, true)
      return false
    }
    return true
  }

  /**
   * 渲染失败时回退为文字
   */
  async replyImage(img, fallbackText) {
    if (img) {
      await this.reply(img)
    } else {
      await this.reply(fallbackText)
    }
  }

  async help() {
    const img = await renderHelp()
    await this.replyImage(img, '帮助图渲染失败，指令：#中转添加 地址 / #中转添加邮箱 地址（AgentRouter、Sub2API）/ #中转列表 / #中转删除 序号 / #中转签到 [序号] / #中转查询 / #中转定时 开|关 [序号]')
    return true
  }

  /**
   * 解析并校验站点地址，非法时返回 null
   */
  parseSite(input) {
    try {
      const baseUrl = normalizeBaseUrl(input)
      const host = new URL(baseUrl).host
      if (!host) return null
      return { baseUrl, host }
    } catch {
      return null
    }
  }

  /**
   * 令牌方式校验：探测站点类型并取用户信息
   * @returns {Promise<{ok, msg?, account?, info?}>}
   */
  async verifyToken(site, token, siteUserId) {
    let probe
    try {
      probe = await guardHang(probeAccount(site.baseUrl, token, siteUserId), '验证账号')
    } catch (err) {
      return { ok: false, msg: err.message }
    }
    if (!probe.ok) return { ok: false, msg: probe.msg }
    return {
      ok: true,
      info: probe.info,
      account: {
        name: site.host,
        baseUrl: site.baseUrl,
        type: probe.type,
        authMode: 'token',
        token,
        loginEmail: null,
        password: null,
        siteUserId: siteUserId || probe.info.siteUserId || null,
        signPath: null,
        auto: true
      }
    }
  }

  /**
   * Cookie 方式校验：按域名选适配器并取用户信息
   * @returns {Promise<{ok, msg?, account?, info?}>}
   */
  async verifyCookie(site, rawSession, siteUserId) {
    const token = String(rawSession).replace(/^session=/i, '')
    // NewAPI 魔改站（如 jianzhile.vip）的签到/验证码接口只认网页会话：
    // session 能直接过 /api/user/self 就按 new-api 会话账号处理，走 /api/user/checkin。
    try {
      const probed = await guardHang(probeSessionAccount(site.baseUrl, token, siteUserId), '识别站点类型')
      if (probed?.ok) {
        return {
          ok: true,
          info: probed.info,
          account: {
            name: site.host,
            baseUrl: site.baseUrl,
            type: 'newapi',
            authMode: 'session',
            token,
            loginEmail: null,
            password: null,
            siteUserId,
            signPath: null,
            auto: true
          }
        }
      }
    } catch {
      // 非 new-api 站点继续按域名规则处理
    }
    const type = cookieTypeForHost(site.host)
    const account = {
      name: site.host,
      baseUrl: site.baseUrl,
      type,
      authMode: 'session',
      token,
      loginEmail: null,
      password: null,
      siteUserId,
      signPath: null,
      auto: true
    }
    try {
      const info = await guardHang(getAdapter(type).userInfo(account), '验证账号')
      if (!info.ok) return { ok: false, msg: `${info.msg}（请检查 session 与用户ID）` }
      return { ok: true, account, info }
    } catch (err) {
      return { ok: false, msg: err.message }
    }
  }

  /**
   * 邮箱登录校验。AgentRouter 与 Sub2API 都用「邮箱 + 站内密码」，但换到的凭据
   * 完全不同（session cookie vs JWT），因此按站点类型分流。
   */
  async verifyEmail(site, loginEmail, password) {
    if (cookieTypeForHost(site.host) !== 'agentrouter') {
      const probe = await guardHang(probeSub2apiSite(site.baseUrl), '识别站点类型')
      if (probe.ok) return await this.verifySub2apiEmail(site, loginEmail, password, probe)
    }
    return await this.verifyAgentRouterEmail(site, loginEmail, password)
  }

  /**
   * Sub2API 邮箱登录校验。登录要过 Turnstile（浏览器），成功后拿到的
   * refresh_token 才是长期凭据；登录本身不触发签到，所以不返回 initialCheckin，
   * 由 saveAccount 的常规首签流程去签。
   */
  async verifySub2apiEmail(site, loginEmail, password, probe) {
    const normalizedEmail = String(loginEmail || '').trim()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
      return { ok: false, msg: '邮箱格式不正确' }
    }
    const account = {
      name: site.host,
      baseUrl: site.baseUrl,
      type: 'sub2api',
      authMode: 'email',
      loginEmail: normalizedEmail,
      password,
      // token 存 refresh_token；accessToken/tokenExpiresAt 由适配器登录后写入
      token: '',
      accessToken: '',
      tokenExpiresAt: null,
      siteUserId: null,
      signPath: null,
      auto: true
    }
    try {
      const login = await guardHang(getAdapter('sub2api').login(account), `登录 ${probe.siteName || 'Sub2API'} 站点`)
      if (!login.ok) {
        // 过码失败是这类站点最常见的失败原因，且与账号密码对不对无关，
        // 单说「登录失败」会让用户反复怀疑密码。附上重试与站点差异说明。
        const turnstileFailed = /人机验证|Turnstile|显示环境/i.test(String(login.msg || ''))
        return {
          ok: false,
          msg: turnstileFailed
            ? `${login.msg}\n（该站点登录需要过人机验证，可再发一次指令重试）`
            : login.msg
        }
      }
      if (!account.token) {
        return { ok: false, msg: '登录成功，但该站点无法维持自动签到，请改用 #中转添加刷新令牌 绑定' }
      }
      const info = await guardHang(getAdapter('sub2api').userInfo(account), '读取账号信息')
      if (!info?.ok) return { ok: false, msg: info?.msg || '登录后读取账号信息失败，请稍后重试' }
      return { ok: true, account, info }
    } catch (err) {
      return { ok: false, msg: err.message }
    }
  }

  /**
   * Sub2API 刷新令牌校验（不开浏览器）。用于登录 Turnstile 等级过高、
   * 本机无法过码的站点：用户自行在浏览器 localStorage 取 refresh_token，
   * 插件立刻消耗它换一对新凭据入库，此后靠每日轮换维持。
   *
   * refresh_token 是一次性的，因此这里必须成功换出新值才算绑定成功，
   * 否则用户会以为绑上了、实际下一轮就 401。
   */
  async verifySub2apiRefresh(site, refreshToken, probe) {
    const token = String(refreshToken || '').trim()
    if (!token) return { ok: false, msg: '刷新令牌不能为空' }

    const account = {
      name: site.host,
      baseUrl: site.baseUrl,
      type: 'sub2api',
      authMode: 'refresh',
      // 该站点过不了码，不保存邮箱密码：留着也无法自动重登，反而多存一份敏感信息
      loginEmail: null,
      password: null,
      token,
      accessToken: '',
      tokenExpiresAt: null,
      siteUserId: null,
      signPath: null,
      auto: true
    }
    try {
      const renewed = await guardHang(
        getAdapter('sub2api').renew(account),
        `验证 ${probe.siteName?.trim() || 'Sub2API'} 刷新令牌`
      )
      if (!renewed.ok) {
        return {
          ok: false,
          msg: `${renewed.msg}\n（刷新令牌是一次性的，请重新取一次，取完不要再操作该站点网页）`
        }
      }
      const info = await guardHang(getAdapter('sub2api').userInfo(account), '读取账号信息')
      if (!info?.ok) return { ok: false, msg: info?.msg || '刷新成功但读取账号信息失败，请稍后重试' }
      return { ok: true, account, info }
    } catch (err) {
      return { ok: false, msg: err.message }
    }
  }

  /**
   * AgentRouter 邮箱登录校验。登录本身会触发签到，因此同时返回首次签到结果，
   * 保存账号时直接复用，避免第二次登录覆盖“本次到账”状态。
   */
  async verifyAgentRouterEmail(site, loginEmail, password) {
    const normalizedEmail = String(loginEmail || '').trim()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
      return { ok: false, msg: '邮箱格式不正确' }
    }
    const account = {
      name: site.host,
      baseUrl: site.baseUrl,
      type: 'agentrouter',
      authMode: 'email',
      loginEmail: normalizedEmail,
      password,
      token: '',
      siteUserId: null,
      signPath: null,
      auto: true
    }
    try {
      const checkin = await guardHang(getAdapter('agentrouter').login(account), '验证 AgentRouter 邮箱登录')
      if (!checkin.ok) return { ok: false, msg: checkin.msg }
      if (!account.siteUserId) return { ok: false, msg: '登录成功，但该站点信息不完整，请稍后重试' }
      if (!account.token) return { ok: false, msg: '登录成功，但该站点信息不完整，请稍后重试' }

      let info = checkin.info
      if (!info?.ok) info = await guardHang(getAdapter('agentrouter').userInfo(account), '读取 AgentRouter 账号')
      if (!info?.ok) return { ok: false, msg: info?.msg || '登录后读取账号信息失败，请稍后重试' }
      return { ok: true, account, info, initialCheckin: checkin }
    } catch (err) {
      return { ok: false, msg: err.message }
    }
  }

  /**
   * 发起绑定会话：记录站点，等用户私聊补发凭据；超时自动取消并回执。
   * 机器人开启 disablePrivate 时：disableAdopt 放行了「中转绑定」则引导用户用
   * 「中转绑定 凭据」格式私聊发送，否则提示替代方案且不登记会话
   */
  async startBind(kind, site) {
    const fullCmd = {
      cookie: `#中转添加cookie ${site.host} session值 用户ID`,
      email: `#中转添加邮箱 ${site.host} 邮箱 ${emailPasswordLabel(site)}`,
      refresh: `#中转添加刷新令牌 ${site.host} 刷新令牌`
    }[kind] || `#中转添加 ${site.host} 令牌`
    const block = await getPrivateBlock(this.e)
    if (block && !block.passable) {
      if (this.e.isGroup) {
        const recallTip = getConfig().recallAdd ? '（机器人会尝试撤回）' : '（注意令牌会暴露在群里，建议发后自行撤回）'
        await this.reply(
          '私聊补发凭据会被拦截，本次未发起绑定。可任选：\n' +
          '1) 请主人在 disableAdopt 中加入 中转 ，之后重新发起，私聊发送：中转绑定 凭据\n' +
          `2) 直接在本群发送完整指令${recallTip}：${fullCmd}`,
          true, { recallMsg: bindRecallSec() }
        )
      } else {
        // 本条私聊指令能到达说明完整指令格式可被放行，单发的裸凭据则会被拦截
        await this.reply(
          '私聊单发凭据会被拦截，本次未发起绑定。' +
          `请直接发送完整指令：${fullCmd}，或请主人在 disableAdopt 中加入 中转 后改发：中转绑定 凭据`
        )
      }
      return
    }

    const key = String(this.e.user_id)
    // 重新发起时撤掉上一次尚未处理的提示
    const stale = clearPending(key)
    if (stale) await recallBindPrompt(stale)

    const timeoutSec = getConfig().bind.timeoutSec || 300
    const pending = {
      kind,
      baseUrl: site.baseUrl,
      host: site.host,
      userId: key,
      selfId: String(this.e.self_id ?? defaultSelfId()),
      groupId: this.e.isGroup ? String(this.e.group_id) : null,
      messageId: this.e.message_id,
      timer: null,
      promptMsgId: null,
      promptTimer: null
    }
    armBindTimeout(pending, timeoutSec)
    pendingBinds.set(key, pending)

    const need = {
      cookie: 'session值 用户ID（空格分隔）',
      email: `邮箱 ${emailPasswordLabel(site)}（空格分隔）`,
      // 站点没有可复制的「令牌」入口，必须告诉用户去哪取，否则根本无从下手
      refresh: '刷新令牌（在电脑浏览器登录该站点后按 F12，在 Console 执行：'
        + "localStorage.getItem('refresh_token') ，把 rt_ 开头的整串发来；取完请不要再刷新该站点页面)"
    }[kind] || '访问令牌（Veloera 站点需再加 空格+站点用户ID）'
    // disablePrivate 开启但「中转绑定」被放行时，凭据必须带该前缀才能通过拦截
    const sendAs = block ? `中转绑定 ${need}` : need
    const mins = Math.max(1, Math.round(timeoutSec / 60))
    if (this.e.isGroup) {
      // 提示消息由插件自己管理撤回：绑定出结果立即撤，否则到 groupRecallSec 兜底撤
      const res = await this.reply(
        `已记录站点 ${pending.host}，请在 ${mins} 分钟内私聊我直接发送：${sendAs}。敏感信息不要发在群里，结果会回到本群提示。\n${BIND_SCOPE_NOTICE}`,
        true
      )
      pending.promptMsgId = res?.message_id ?? null
      const sec = bindRecallSec()
      if (sec > 0 && pending.promptMsgId) {
        pending.promptTimer = setTimeout(() => recallBindPrompt(pending), sec * 1000)
      }
    } else {
      await this.reply(`已记录站点 ${pending.host}，请在 ${mins} 分钟内直接发送：${sendAs}\n${BIND_SCOPE_NOTICE}`)
    }
  }

  /**
   * #中转添加 地址            → 发起绑定，私聊补发令牌（推荐群内用法）
   * #中转添加 地址 令牌 [用户ID] → 直接添加（建议私聊使用）
   * 规则放宽到任意段数：参数过多时也能撤回消息并提示，避免令牌静默留在群里
   */
  async add() {
    const args = String(this.e.msg).trim().split(/\s+/).slice(1)
    const site = this.parseSite(args[0])

    const specializedHint = specializedBindingHint(site)
    if (specializedHint) {
      // 完整指令可能带有敏感令牌，先撤回；仅发地址的引导指令不含敏感信息。
      if (args.length > 1) await this.recallIfGroup()
      await this.reply(specializedHint)
      return true
    }

    // Sub2API 站点域名任意，只能问一次公开配置接口。它没有 new-api 的令牌体系，
    // 直接走令牌绑定只会得到「令牌验证失败」这种看不懂的报错，先引导到邮箱绑定。
    if (site) {
      const probe = await probeSub2apiSite(site.baseUrl).catch(() => ({ ok: false }))
      if (probe.ok) {
        if (args.length > 1) await this.recallIfGroup()
        await this.reply(
          `检测到 ${site.host} 是 Sub2API 站点${probe.siteName ? `（${probe.siteName.trim()}）` : ''}，` +
          `它没有系统访问令牌，请改用：\n#中转添加邮箱 ${site.baseUrl}\n随后私聊发送：邮箱 登录密码`
        )
        return true
      }
    }

    if (args.length === 1) {
      if (!site) {
        await this.reply('站点地址格式不正确或被安全策略拒绝，请填写 HTTPS 站点根地址，例如：#中转添加 https://xx.com')
        return true
      }
      await this.startBind('token', site)
      return true
    }

    await this.recallIfGroup()
    if (!site) {
      await this.reply('站点地址格式不正确或被安全策略拒绝，请填写 HTTPS 站点根地址，例如：#中转添加 https://xx.com 令牌')
      return true
    }
    if (args.length > 3) {
      await this.reply('参数过多：#中转添加 地址 令牌 [站点用户ID]（令牌中不能含空格）')
      return true
    }

    // 加锁：入库会改动 accounts 数组，不能与正在进行的签到/删除交错
    await this.runLocked('添加账号', async () => {
      await this.reply('正在验证账号，请稍候...')
      const r = await this.verifyToken(site, args[1], args[2] || null)
      if (!r.ok) {
        await this.reply(`添加失败：${r.msg}`)
        return
      }
      await this.saveAccount(r.account, r.info)
    })
    return true
  }

  /**
   * #中转添加cookie 地址                  → 发起绑定，私聊补发 session 与用户ID
   * #中转添加cookie 地址 session值 用户ID → 直接添加（建议私聊使用）
   * AgentRouter 的 Cookie 只能查余额，统一引导到邮箱登录流程。
   */
  async addCookie() {
    const args = String(this.e.msg).trim().split(/\s+/).slice(1)
    const site = this.parseSite(args[0])

    const agentRouterHint = agentRouterCookieHint(site)
    if (agentRouterHint) {
      if (args.length > 1) await this.recallIfGroup()
      await this.reply(agentRouterHint)
      return true
    }

    if (args.length === 1) {
      if (!site) {
        await this.reply('站点地址格式不正确或被安全策略拒绝，请填写 HTTPS 站点根地址，例如：#中转添加cookie https://xx.com')
        return true
      }
      await this.startBind('cookie', site)
      return true
    }

    await this.recallIfGroup()
    if (!site) {
      await this.reply('站点地址格式不正确或被安全策略拒绝，请填写 HTTPS 站点根地址，例如：#中转添加cookie https://xx.com session值 用户ID')
      return true
    }
    if (args.length !== 3) {
      await this.reply(args.length === 2
        ? '缺少站点用户ID，格式：#中转添加cookie 地址 session值 用户ID（或只发地址走私聊绑定）'
        : '参数过多：#中转添加cookie 地址 session值 用户ID（session 中不能含空格）')
      return true
    }

    await this.runLocked('添加账号', async () => {
      await this.reply('正在验证账号，请稍候...')
      const r = await this.verifyCookie(site, args[1], args[2])
      if (!r.ok) {
        await this.reply(`添加失败：${r.msg}`)
        return
      }
      await this.saveAccount(r.account, r.info)
    })
    return true
  }

  /**
   * #中转添加邮箱 地址                → 发起邮箱绑定（AgentRouter / Sub2API）
   * #中转添加邮箱 地址 邮箱 站内密码  → 直接添加（建议仅私聊使用）
   */
  async addEmail() {
    const args = String(this.e.msg).trim().split(/\s+/).slice(1)
    const site = this.parseSite(args[0])

    if (args.length === 1) {
      if (!site) {
        await this.reply('站点地址格式不正确或被安全策略拒绝，例如：#中转添加邮箱 https://agentrouter.org')
        return true
      }
      // 非 AgentRouter 域名时探测一次是否为 Sub2API，两者都不是就不该走邮箱绑定
      if (cookieTypeForHost(site.host) !== 'agentrouter') {
        const probe = await probeSub2apiSite(site.baseUrl).catch(() => ({ ok: false }))
        if (!probe.ok) {
          await this.reply('邮箱登录绑定仅用于 AgentRouter（agentrouter.org / *.air-outer.com）与 Sub2API 站点，其他站点请用 #中转添加 地址')
          return true
        }
      }
      await this.startBind('email', site)
      return true
    }

    await this.recallIfGroup()
    if (!site) {
      await this.reply('请填写站点 HTTPS 根地址，例如：#中转添加邮箱 https://agentrouter.org 邮箱 站内密码')
      return true
    }
    if (args.length !== 3) {
      await this.reply('格式：#中转添加邮箱 地址 邮箱 站内密码（推荐只发地址，再私聊补发凭据）')
      return true
    }

    await this.runLocked('添加邮箱账号', async () => {
      await this.reply('正在登录并验证账号，请稍候...')
      const r = await this.verifyEmail(site, args[1], args[2])
      if (!r.ok) {
        await this.reply(`添加失败：${r.msg}`)
        return
      }
      await this.saveAccount(r.account, r.info, r.initialCheckin)
    })
    return true
  }

  /**
   * #中转添加刷新令牌 地址        → 发起刷新令牌绑定
   * #中转添加刷新令牌 地址 令牌   → 直接添加（建议仅私聊使用）
   *
   * 用于登录人机验证等级过高、本机无法过码的 Sub2API 站点。
   * 用户在浏览器控制台执行 localStorage.getItem('refresh_token') 自取。
   */
  async addRefresh() {
    const args = rawText(this.e).replace(/^[#＃]中转(?:站)?添加刷新令牌\s*/, '').split(/\s+/).filter(Boolean)
    const site = this.parseSite(args[0])

    if (args.length === 1) {
      if (!site) {
        await this.reply('站点地址格式不正确或被安全策略拒绝，例如：#中转添加刷新令牌 https://站点域名')
        return true
      }
      const probe = await probeSub2apiSite(site.baseUrl).catch(() => ({ ok: false }))
      if (!probe.ok) {
        await this.reply('刷新令牌绑定仅用于 Sub2API 站点；其他站点请用 #中转添加 地址 或 #中转添加邮箱 地址')
        return true
      }
      await this.startBind('refresh', site)
      return true
    }

    await this.recallIfGroup()
    if (!site) {
      await this.reply('请填写站点 HTTPS 根地址，例如：#中转添加刷新令牌 https://站点域名 rt_xxx')
      return true
    }
    if (args.length !== 2) {
      await this.reply('格式：#中转添加刷新令牌 地址 刷新令牌（推荐只发地址，再私聊补发令牌）')
      return true
    }

    await this.runLocked('添加刷新令牌账号', async () => {
      const probe = await probeSub2apiSite(site.baseUrl).catch(() => ({ ok: false }))
      if (!probe.ok) {
        await this.reply('该站点不是 Sub2API，无法用刷新令牌绑定')
        return
      }
      await this.reply('正在验证刷新令牌，请稍候...')
      const r = await this.verifySub2apiRefresh(site, args[1], probe)
      if (!r.ok) {
        await this.reply(`添加失败：${r.msg}`)
        return
      }
      await this.saveAccount(r.account, r.info)
    })
    return true
  }

  /**
   * 私聊补发凭据：命中绑定会话时完成校验入库，并回执到发起的群。
   * 支持「中转绑定 凭据」前缀格式（配合 disablePrivate 的 disableAdopt 通行字符串放行）；
   * 凭据从原始消息文本解析，避免开头的 / # 等字符被核心归一化改坏
   */
  async bindCredentials() {
    const raw = rawText(this.e)
    if (!raw) return false
    const prefixed = /^[#＃/\\]?\s*中转(?:站)?绑定/.test(raw)

    if (this.e.isGroup) {
      // 带前缀说明是误发到群的凭据：尽量撤回并提醒；普通群聊消息放行
      if (prefixed) {
        await this.recallIfGroup()
        await this.reply('凭据请私聊我发送，不要发在群里', false, { recallMsg: bindRecallSec() })
        return true
      }
      return false
    }

    const key = String(this.e.user_id)
    const pending = pendingBinds.get(key)
    if (!pending) {
      if (prefixed) {
        await this.reply('当前没有等待绑定的站点，请先发送：#中转添加 地址、#中转添加cookie 地址、#中转添加邮箱 地址 或 #中转添加刷新令牌 地址')
        return true
      }
      return false
    }
    // 原文确实以 # 开头的是指令，放行给其他插件；凭据不会以 # 开头
    if (!prefixed && /^[#＃]/.test(raw)) return false

    const parts = raw.replace(/^[#＃/\\]?\s*中转(?:站)?绑定\s*/, '').split(/\s+/).filter(Boolean)
    if (!parts.length) {
      if (prefixed) {
        await this.reply('请在 中转绑定 后附上凭据，例如：中转绑定 令牌')
        return true
      }
      return false
    }
    if (pending.kind === 'cookie' && parts.length !== 2) {
      // 用户走「中转绑定」前缀（disablePrivate 放行）时，重发也必须带前缀才不被拦截
      const fmt = prefixed ? '中转绑定 session值 用户ID' : 'session值 用户ID'
      await this.reply(`请一次性发送：${fmt}（空格分隔，不能多填参数）`)
      return true
    }
    if (pending.kind === 'email' && parts.length !== 2) {
      const label = emailPasswordLabel(pending)
      const fmt = prefixed ? `中转绑定 邮箱 ${label}` : `邮箱 ${label}`
      const extra = label === 'AgentRouter站内密码' ? '；不是 GitHub/LinuxDO 密码' : ''
      await this.reply(`请一次性发送：${fmt}（空格分隔${extra}）`)
      return true
    }
    if (pending.kind === 'token' && parts.length > 2) {
      await this.reply('参数过多，请发送：令牌 [站点用户ID]')
      return true
    }
    if (pending.kind === 'refresh' && parts.length !== 1) {
      const fmt = prefixed ? '中转绑定 刷新令牌' : '刷新令牌'
      await this.reply(`请只发送一个值：${fmt}（形如 rt_ 开头的长字符串，中间不能有空格）`)
      return true
    }

    const site = { baseUrl: pending.baseUrl, host: pending.host }

    // 加锁：入库会改动 accounts 数组，不能与正在进行的签到/删除交错。
    // 会话必须在拿到锁之后才消费——锁忙时保留会话，用户稍后重发凭据即可，
    // 否则刚发来的凭据会被丢弃且要重走一遍添加流程
    let locked
    try {
      locked = await withUserLock(this.e.user_id, '绑定账号', async () => {
        // 进入验证即消费会话，避免验证期间超时重复回执
        clearPending(key)
        await this.reply('正在验证账号，请稍候...')
        let r
        if (pending.kind === 'cookie') {
          r = await this.verifyCookie(site, parts[0], parts[1])
        } else if (pending.kind === 'email') {
          r = await this.verifyEmail(site, parts[0], parts[1])
        } else if (pending.kind === 'refresh') {
          const probe = await probeSub2apiSite(site.baseUrl).catch(() => ({ ok: false }))
          r = probe.ok
            ? await this.verifySub2apiRefresh(site, parts[0], probe)
            : { ok: false, msg: '该站点不是 Sub2API，无法用刷新令牌绑定' }
        } else {
          r = await this.verifyToken(site, parts[0], parts[1] || null)
        }

        if (!r.ok) {
          await recallBindPrompt(pending)
          await this.reply(`绑定失败：${r.msg}\n可重新发送添加指令再试`)
          await notifyBindGroup(pending, `中转站 ${pending.host} 绑定失败：${r.msg}`)
          return
        }

        const { entry, resultRow, image } = await this.saveAccount(r.account, r.info, r.initialCheckin)
        // 群里发起的绑定：保留最近使用群信息（私聊补发凭据时事件里没有群号）
        if (pending.groupId) {
          rememberGroup(entry, pending.groupId)
          persist()
        }
        await recallBindPrompt(pending)
        await notifyBindGroup(pending, formatResultRows([resultRow]), image)
      })
    } catch (err) {
      // 未预见的异常也要回执，否则表现为「发了凭据没反应」
      logger.error('[relay-checkin-plugin] 绑定账号执行异常:', err)
      await this.reply(`绑定出错了，可重新发送添加指令再试`)
      return true
    }
    if (!locked.ok) {
      // 会话原本的超时是从发起时起算，等待锁的这段时间要还给用户，
      // 否则他按提示等完再发凭据时会话可能已过期
      const timeoutSec = getConfig().bind.timeoutSec || 300
      armBindTimeout(pending, timeoutSec)
      const mins = Math.max(1, Math.round(timeoutSec / 60))
      await this.reply(
        `你的「${locked.busy.label}」正在进行中（已 ${locked.busy.seconds} 秒），本次凭据未保存。` +
        `等它完成后在 ${mins} 分钟内再发一次凭据即可，无需重发添加指令`
      )
    }
    return true
  }

  /**
   * 保存账号（同站点同站点用户ID才更新凭据，否则新增），随后立即签到一次
   * （已签会识别为今日已签，未签顺带签上，让列表的签到状态从添加起就准确），
   * 并把添加与签到状态合并到同一行图片中
   */
  async saveAccount(account, info, initialCheckin = null) {
    account.username = info.username || ''
    account.lastBalance = info.balanceText || '-'
    // 回填验证阶段查到的站点用户ID：upsertAccount 先比 siteUserId、都缺时才比令牌，
    // 而 Sub2API 的 refresh_token 每次绑定都会轮换，缺 ID 就会把重新绑定的同一个账号
    // 当成新账号追加，列表里出现重复条目
    if (account.siteUserId == null && info.siteUserId != null) {
      account.siteUserId = info.siteUserId
    }
    const { entry, updated, account: stored } = upsertAccount(this.e, account)
    const statusText = updated ? '已更新凭据' : '添加成功'

    let rows
    try {
      rows = await guardHang(checkinAccountResults(stored, { initialCheckin, info }), '签到')
      // 缓存落盘失败不能让一次成功的签到被报成失败
      try {
        persist()
      } catch (err) {
        logger.error(`[relay-checkin-plugin] 状态缓存落盘失败: ${err?.message || err}`)
      }
    } catch (err) {
      rows = [{
        name: accountLabel(stored), status: 'fail', statusText: '签到失败',
        award: '', balance: info.balanceText, msg: err.message
      }]
    }
    const [checkinRow, ...activityRows] = rows
    const combinedRow = combineCheckinResults(rows)
    const balance = combinedRow.balance !== '-' ? combinedRow.balance : info.balanceText
    const mergedRow = {
      ...combinedRow,
      name: accountLabel(stored),
      statusText: `${statusText} / ${checkinRow.statusText || '签到结果未知'}`,
      balance,
      msg: combinedRow.msg || ''
    }

    const img = await renderResult({
      title: '中转站账号',
      users: [{
        nickname: entry.nickname,
        userId: entry.userId,
        accounts: [mergedRow]
      }]
    })
    await this.replyImage(img, formatResultRows([mergedRow]))
    return { entry, statusText, checkinRow, activityRows, balance, image: img, resultRow: mergedRow }
  }

  async list() {
    const entry = touchEntry(this.e)
    if (!entry || !entry.accounts.length) {
      await this.reply('你还没有添加账号，发送 #中转帮助 查看用法')
      return true
    }
    await this.runLocked('列表', async () => {
      // 实时刷新余额（AnyRouter 等浏览器站耗时长，用缓存）；签到状态来自本插件签到记录
      await refreshBalances(entry)
      const img = await renderList(entry)
      await this.replyImage(img, '列表渲染失败，请稍后重试')
    })
    return true
  }

  /**
   * 删除账号：与签到共用用户锁，避免签到遍历期间数组变动导致错位
   */
  async remove() {
    const index = Number(/(\d+)/.exec(this.e.msg)[1])
    await this.runLocked('删除账号', async () => {
      const removed = removeAccount(this.e, index)
      if (!removed) {
        await this.reply(`删除失败：序号 ${index} 不存在，发送 #中转列表 查看`)
      } else {
        await this.reply(`已删除账号 [${index}] ${accountLabel(removed)}`)
      }
    })
    return true
  }

  async checkin() {
    const entry = touchEntry(this.e)
    if (!entry || !entry.accounts.length) {
      await this.reply('你还没有添加账号，发送 #中转帮助 查看用法')
      return true
    }

    const indexMatch = /^#中转(?:站)?签到\s*(\d+)$/.exec(this.e.msg)
    const index = indexMatch ? Number(indexMatch[1]) : null
    if (index !== null && (index < 1 || index > entry.accounts.length)) {
      await this.reply(`序号 ${index} 不存在，发送 #中转列表 查看`)
      return true
    }

    await this.runLocked('签到', async () => {
      const targets = index ? [entry.accounts[index - 1]] : entry.accounts
      await this.reply(index
        ? `正在签到 [${index}] ${accountLabel(targets[0])}，请稍候...`
        : progressTip(targets))
      const results = await checkinEntry(entry, { index })
      const img = await renderResult({
        title: '中转站签到',
        users: [{ nickname: entry.nickname, userId: entry.userId, accounts: results }]
      })
      await this.replyImage(img, formatResultRows(results))
    })
    return true
  }

  async query() {
    const entry = touchEntry(this.e)
    if (!entry || !entry.accounts.length) {
      await this.reply('你还没有添加账号，发送 #中转帮助 查看用法')
      return true
    }

    await this.runLocked('余额查询', async () => {
      await this.reply('正在查询，请稍候...')
      const results = await queryEntry(entry)
      const img = await renderResult({
        title: '中转站余额查询',
        users: [{ nickname: entry.nickname, userId: entry.userId, accounts: results }]
      })
      await this.replyImage(img, results.map(r => `${r.name}: 余额 ${r.balance}`).join('\n'))
    })
    return true
  }

  /**
   * #中转定时 开/关       → 本人定时签到总开关
   * #中转定时 开/关 序号  → 单个账号的定时开关（默认开）
   */
  async toggleAuto() {
    const match = /^#中转(?:站)?定时\s*(开|关)\s*(\d+)?$/.exec(this.e.msg)
    if (!match) return false
    const enable = match[1] === '开'
    const index = match[2] ? Number(match[2]) : null

    if (index !== null) {
      // 按序号操作，与签到/删除共用用户锁避免错位
      await this.runLocked('定时开关', async () => {
        const acc = setAccountAuto(this.e, index, enable)
        if (!acc) {
          await this.reply(`序号 ${index} 不存在，发送 #中转列表 查看`)
        } else {
          await this.reply(`已${enable ? '开启' : '关闭'} [${index}] ${accountLabel(acc)} 的定时签到`)
        }
      })
      return true
    }

    setAuto(this.e, enable)
    await this.reply(`定时签到总开关已${enable ? '开启' : '关闭'}（可用 #中转定时 开/关 序号 单独控制某个账号）`)
    return true
  }

  /**
   * #中转开启群推送 / #中转关闭群推送（兼容 #中转开启定时签到群推送）
   * 开启过的群是固定推送目标，将收到全部定时签到结果；仅群主/管理员/机器人主人可操作
   */
  async togglePushGroup() {
    if (!this.e.isGroup) {
      await this.reply('请在需要开启/关闭推送的群里发送该指令')
      return true
    }
    const role = this.e.sender?.role
    const isAdmin = this.e.isMaster || this.e.member?.is_owner || this.e.member?.is_admin ||
      role === 'owner' || role === 'admin'
    if (!isAdmin) {
      await this.reply('仅群主/管理员或机器人主人可操作本群的定时推送开关')
      return true
    }

    const enable = this.e.msg.includes('开启')
    const changed = setPushGroup(this.e.group_id, enable)
    if (enable) {
      await this.reply(changed
        ? '已开启本群的定时签到结果推送（将推送全部用户的定时签到结果）'
        : '本群已处于开启状态')
    } else {
      await this.reply(changed ? '已关闭本群的定时签到结果推送' : '本群本来就未开启推送')
    }
    return true
  }
}
