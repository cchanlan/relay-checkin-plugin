import { getConfig } from './config.js'
import { allEntries, getEntry, getPushGroups } from './store.js'
import { checkinEntry, sleep, randInt } from './executor.js'
import { renderResult, renderResultPages } from './render.js'
import { withUserLock } from './lock.js'
import { buildGroupPushPlan } from './push-plan.js'
import { logger, pickBot } from '../host/index.js'
import { beijingClock, shouldScheduleAccount } from './checkin-policy.js'

let running = false

/**
 * 定时任务入口：全量签到 + 按配置推送结果
 */
export async function runScheduledCheckin({ siteOnly = false } = {}) {
  const cfg = getConfig()
  if (!cfg.schedule.enable) return
  const day = beijingClock().day
  const accountFilter = account => (!siteOnly || beijingClock().day === day)
    && shouldScheduleAccount(account, { siteOnly })
  // 分钟检查空转时不占锁、不抖动、不刷日志；手动签到成功后也无需再查一次。
  if (siteOnly && !allEntries().some(en => en.autoCheckin && en.accounts.some(accountFilter))) return
  if (running) {
    if (!siteOnly) logger.warn('[relay-checkin-plugin] 上一轮定时签到尚未结束，跳过本次')
    return
  }
  running = true

  try {
    // 随机延迟，避免所有人固定整点签到
    const jitter = cfg.schedule.jitterMinutes || 0
    if (jitter > 0) {
      const delayMs = randInt(0, jitter * 60) * 1000
      logger.info(`[relay-checkin-plugin] 定时签到将在 ${Math.round(delayMs / 1000)} 秒后开始`)
      await sleep(delayMs)
    }

    // 总开关打开且至少有一个账号开着单账号定时开关的用户才参与
    const entries = allEntries().filter(en => en.autoCheckin && en.accounts.some(accountFilter))
    if (!entries.length) {
      logger.info('[relay-checkin-plugin] 无需要定时签到的账号')
      return
    }
    logger.info(`[relay-checkin-plugin] 开始定时签到，共 ${entries.length} 个用户`)

    // 账号/用户间随机间隔，配置非法时回落默认值
    const delayRange = Array.isArray(cfg.schedule.accountDelay) && cfg.schedule.accountDelay.length === 2
      ? cfg.schedule.accountDelay
      : [5, 15]

    // 多用户并发执行（上限由 schedule.concurrency 控制），单用户内部仍逐账号串行；
    // 与手动指令共用用户锁：用户正在手动操作时跳过，避免同一账号被签两次
    const concurrency = Math.max(1, Math.min(cfg.schedule.concurrency || 3, 10))
    const done = []
    let cursor = 0
    let skipped = 0

    const worker = async () => {
      while (cursor < entries.length) {
        const entry = entries[cursor++]
        // 单个用户失败（落盘异常、适配器异常等）不能拖垮整轮，否则已签完的用户全收不到推送
        try {
          // 用户间随机间隔，避免整批请求特征过于集中
          await sleep(randInt(delayRange[0], delayRange[1]) * 1000)
          const r = await withUserLock(entry.userId, '定时签到', () => {
            const liveEntry = getEntry({ user_id: entry.userId })
            return liveEntry?.autoCheckin && getConfig().schedule.enable ? checkinEntry(liveEntry, {
              delayRange, autoOnly: true, accountFilter,
              onAccountDone: siteOnly ? account => { account.lastSiteAutoDay = day } : null
            }) : []
          })
          if (!r.ok) {
            skipped++
            logger.info(`[relay-checkin-plugin] 用户 ${entry.userId} 正在手动操作（${r.busy.label}），本轮跳过`)
            continue
          }
          if (r.result.length) done.push({ entry, results: r.result })
        } catch (err) {
          logger.error(`[relay-checkin-plugin] 用户 ${entry.userId} 定时签到异常: ${err?.message || err}`)
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, entries.length) }, worker))
    if (skipped) logger.info(`[relay-checkin-plugin] 本轮跳过 ${skipped} 个正在手动操作的用户`)

    if (done.length) await pushResults(done, cfg)
    logger.info('[relay-checkin-plugin] 定时签到完成')
  } catch (err) {
    logger.error('[relay-checkin-plugin] 定时签到异常:', err)
  } finally {
    running = false
  }
}

function toUserBlock({ entry, results }) {
  return { nickname: entry.nickname || entry.userId, userId: entry.userId, accounts: results }
}

/**
 * 按配置推送签到结果。
 * group 模式：将全部签到结果推送到 push_groups.json 中的每一个群；
 * 一个群都没推成功（未配置目标群/机器人已退群/发送失败）时私聊兜底，
 * 保证签到执行了就一定尝试过通知，不会静默丢弃
 */
async function pushResults(done, cfg) {
  const mode = cfg.push.mode || 'group'
  if (mode === 'off') return

  if (mode === 'private') {
    for (const item of done) {
      await pushPrivate(item)
      await sleep(1500)
    }
    return
  }

  const targetGroups = getPushGroups()
  if (targetGroups.length) {
    logger.info(`[relay-checkin-plugin] 群推送目标: ${targetGroups.join(', ')}`)
  } else {
    logger.info('[relay-checkin-plugin] 未配置群推送目标，结果将改为私聊')
  }

  // 同一机器人名下的全部用户合并推送到每个固定目标群。
  // 多机器人仍分别使用账号数据所属的机器人发送，避免跨机器人选错发送身份。
  const groups = buildGroupPushPlan(done, targetGroups)

  // 至少成功推送到一个群的用户，不再私聊兜底
  const delivered = new Set()
  for (const { selfId, groupId, items } of groups) {
    try {
      const bot = pickBot(selfId)
      if (!bot) {
        logger.error(`[relay-checkin-plugin] 账号 ${selfId} 不在线，群 ${groupId} 推送跳过`)
        continue
      }
      const users = items.map(toUserBlock)
      // 每张图最多 usersPerImage 个用户，超出分页成多张图合并转发
      const images = await renderResultPages({ title: '中转站定时签到', users })
      if (!images.length) continue
      // 中性的转发节点形状，由宿主适配层翻译成各自的字段名
      const nodes = images.map(img => ({
        message: img,
        name: '中转站签到',
        uid: bot.selfId || String(selfId)
      }))
      await bot.sendForwardToGroup(groupId, nodes)
      logger.info(`[relay-checkin-plugin] 群 ${groupId} 推送成功，共 ${items.length} 个用户`)
      for (const it of items) delivered.add(it.entry.userId)
    } catch (err) {
      logger.error(`[relay-checkin-plugin] 群 ${groupId} 推送失败: ${err?.message || err}`)
    }
    await sleep(2000)
  }

  // 私聊兜底：一个固定目标群都没推成功的用户
  for (const item of done) {
    if (delivered.has(item.entry.userId)) continue
    logger.info(`[relay-checkin-plugin] 用户 ${item.entry.userId} 未能推送到任何群，改为私聊`)
    await pushPrivate(item)
    await sleep(1500)
  }
}

async function pushPrivate({ entry, results }) {
  try {
    const img = await renderResult({
      title: '中转站定时签到',
      users: [toUserBlock({ entry, results })]
    })
    if (!img) return
    const bot = pickBot(entry.selfId)
    if (!bot) {
      logger.error(`[relay-checkin-plugin] 账号 ${entry.selfId} 不在线，私聊 ${entry.userId} 推送跳过`)
      return
    }
    await bot.sendPrivate(entry.userId, img)
  } catch (err) {
    logger.error(`[relay-checkin-plugin] 私聊 ${entry.userId} 推送失败: ${err?.message || err}`)
  }
}
