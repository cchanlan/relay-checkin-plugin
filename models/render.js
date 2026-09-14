import { getConfig } from './config.js'
import { renderTemplate } from '../host/index.js'
import { accountLabel } from './store.js'

function now() {
  const d = new Date()
  const pad = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

const COMMON_CN_DIGITS = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九']
const FINANCIAL_CN_DIGITS = ['零', '壹', '贰', '叁', '肆', '伍', '陆', '柒', '捌', '玖']

function chineseInteger(value, digits) {
  const n = Math.max(0, Math.floor(Number(value) || 0))
  if (n < 10) return digits[n]
  if (n < 20) return `十${n % 10 ? digits[n % 10] : ''}`
  if (n < 100) return `${digits[Math.floor(n / 10)]}十${n % 10 ? digits[n % 10] : ''}`
  return String(n)
}

/** 图片不可用时，按相同结果行输出文字，签到与抽奖仍保持分行。 */
export function formatResultRows(rows) {
  return rows.map(row => `${row.name}: ${row.statusText}`
    + (row.award ? ` ${row.award}` : '')
    + (row.balance && row.balance !== '-' ? `，余额${row.balance}` : '')
    + (row.msg ? `（${row.msg}）` : '')).join('\n')
}

function resultSeal(title) {
  if (/查询/.test(title)) return { top: '余额', bottom: '已录' }
  if (/账号/.test(title)) return { top: '账号', bottom: '已录' }
  return { top: '签到', bottom: '已毕' }
}

function resultViewData(users) {
  const summary = { total: 0, ok: 0, notice: 0, fail: 0 }
  const decoratedUsers = users.map((user, index) => {
    for (const account of user.accounts) {
      summary.total++
      if (account.status === 'ok') summary.ok++
      else if (account.status === 'already' || account.status === 'unknown') summary.notice++
      else summary.fail++
    }
    const sectionIndex = index + 1
    return {
      ...user,
      sectionMark: chineseInteger(sectionIndex, FINANCIAL_CN_DIGITS),
      sectionText: `用户${chineseInteger(sectionIndex, COMMON_CN_DIGITS)}`
    }
  })
  const summaryItems = [
    { label: '结果条目', tone: '', mark: chineseInteger(summary.total, FINANCIAL_CN_DIGITS), value: summary.total },
    { label: '执行成功', tone: 'ok', mark: chineseInteger(summary.ok, FINANCIAL_CN_DIGITS), value: summary.ok },
    { label: '已完成 / 待核', tone: 'notice', mark: chineseInteger(summary.notice, FINANCIAL_CN_DIGITS), value: summary.notice },
    { label: '执行异常', tone: 'fail', mark: chineseInteger(summary.fail, FINANCIAL_CN_DIGITS), value: summary.fail }
  ]
  return { users: decoratedUsers, summaryItems }
}

/**
 * 通用模板渲染，返回可直接发送的图片消息段（失败返回 false）
 * 具体出图方式由宿主决定：TRSS 走 Yunzai 的 lib/puppeteer，NG 走插件自带的
 * art-template + puppeteer（NG 目前没有官方渲染器插件可用）
 */
async function render(tplName, data) {
  return await renderTemplate(tplName, data)
}

/**
 * 渲染结果卡片（签到/查询/添加共用）
 * users: [{ nickname, userId, accounts: [{ name, status, statusText, award, balance, msg }] }]
 */
export async function renderResult({ title, subtitle = '', users }) {
  const view = resultViewData(users)
  return await render('result', {
    title,
    subtitle,
    time: now(),
    seal: resultSeal(title),
    ...view
  })
}

/**
 * 按每图最多 N 个用户分页渲染，返回图片数组（群合并转发用）
 * 6 个用户、N=5 时 → 2 张图
 */
export async function renderResultPages({ title, users }) {
  const per = Math.max(1, getConfig().push.usersPerImage || 5)
  const pages = []
  for (let i = 0; i < users.length; i += per) {
    pages.push(users.slice(i, i + per))
  }
  const images = []
  for (let i = 0; i < pages.length; i++) {
    const subtitle = pages.length > 1 ? `第 ${i + 1}/${pages.length} 页` : ''
    const img = await renderResult({ title, subtitle, users: pages[i] })
    if (img) images.push(img)
  }
  return images
}

/**
 * 渲染账号列表（余额/签到状态来自最近一次操作的缓存）
 */
export async function renderList({ nickname, userId, autoCheckin, accounts }) {
  const rows = accounts.map((acc, i) => {
    const checkedToday = acc.lastCheckinConfirmed !== false && isCheckedToday(acc.lastCheckinAt)
    const uncertainToday = acc.lastCheckinConfirmed === false && isCheckedToday(acc.lastCheckinAttemptAt)
    const autoOn = acc.auto !== false
    return {
      index: i + 1,
      indexMark: chineseInteger(i + 1, FINANCIAL_CN_DIGITS),
      indexText: `账号${chineseInteger(i + 1, COMMON_CN_DIGITS)}`,
      name: accountLabel(acc),
      baseUrl: acc.baseUrl,
      typeLabel: { newapi: 'new-api', veloera: 'Veloera', generic: 'Cookie', agentrouter: 'AgentRouter', anyrouter: 'AnyRouter', sub2api: 'Sub2API' }[acc.type] || acc.type,
      tokenMasked: maskToken(acc.token),
      // Sub2API 刷新令牌绑定的账号没有邮箱密码，标明凭据种类才能看出该账号是怎么维持的
      credentialLabel: acc.authMode === 'email' ? '邮箱' : (acc.authMode === 'refresh' ? '刷新令牌' : '令牌'),
      credentialMasked: acc.authMode === 'email' ? maskEmail(acc.loginEmail) : maskToken(acc.token),
      balance: acc.lastBalance || '-',
      checkinText: checkedToday ? '今日已签' : (uncertainToday ? '签到未确认' : '今日未签'),
      checkinClass: checkedToday ? 'on' : (uncertainToday ? 'warn' : 'off'),
      autoText: autoOn ? '定时开' : '定时关',
      autoClass: autoOn ? 'on' : 'off'
    }
  })
  return await render('list', {
    nickname,
    userId,
    autoText: autoCheckin ? '已开启' : '已关闭',
    accountCount: rows.length,
    accountCountMark: chineseInteger(rows.length, FINANCIAL_CN_DIGITS),
    time: now(),
    accounts: rows
  })
}

/**
 * lastCheckinAt 是否为今天（本地时区；仅统计有接口证据确认的签到记录）
 */
function isCheckedToday(iso) {
  if (!iso) return false
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return false
  const n = new Date()
  return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate()
}

/**
 * 渲染帮助
 */
export async function renderHelp() {
  return await render('help', { time: now() })
}

function maskToken(token) {
  const t = String(token || '')
  if (t.length <= 8) return '****'
  return t.slice(0, 4) + '****' + t.slice(-4)
}

function maskEmail(email) {
  const value = String(email || '')
  const at = value.indexOf('@')
  if (at <= 0) return '****'
  return value.slice(0, 1) + '***' + value.slice(at)
}
