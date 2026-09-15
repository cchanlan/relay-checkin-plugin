/**
 * Yunzai NG 入口
 *
 * NG 与 TRSS 的差别全部收在 host/ng.js、ng/event.js 与本文件里：
 * 指令逻辑（apps/checkin.js）、站点适配器、浏览器过码、OCR 全是共用的。
 *
 * 装到 NG：把本插件目录放进 `$YZNG_HOME/plugins/`，package.json 的
 * `yunzai.entry` 指向本文件。TRSS 仍走根目录 index.js，互不影响。
 */
import { definePlugin } from '@yunzai-ng/core'
import { installHost } from '../host/index.js'
import { createNgHost } from '../host/ng.js'
import { COMMAND_RULES, CHECKIN_TASK_NAME, RelayCheckinCore, disposeBinds } from '../apps/checkin.js'
import { disposeConfig } from '../models/config.js'
import { closeBrowser } from '../models/browser.js'
import { runScheduledCheckin } from '../models/scheduler.js'
import { configSchema } from './schema.js'
import { wrapEvent, replyFor } from './event.js'
import { disposeRenderer } from './render.js'

/**
 * 把共用的指令表铺成 NG 命令
 * @param {object} ctx 插件上下文
 */
function registerCommands(ctx) {
  for (const rule of COMMAND_RULES) {
    const options = {
      desc: rule.desc,
      // 兜底规则（命中任意消息的私聊补发凭据）必须排在正常指令之后，且不阻断后续命令：
      // 它对绝大多数消息都返回 false（不是给它的），阻断了会把别的插件全废掉
      priority: rule.fallback ? 9000 : 100,
      block: !rule.fallback,
      hidden: Boolean(rule.fallback)
    }
    ctx.command(new RegExp(rule.reg), options).action(async e => {
      const core = new RelayCheckinCore({ e: wrapEvent(e), reply: replyFor(e) })
      return await core[rule.fnc]()
    })
  }
}

/**
 * 注册定时签到，并在配置里的 cron 改动后重建
 *
 * TRSS 那边改 cron 必须重启 Yunzai（task 在 constructor 里固化）；NG 这边靠
 * ctx.config.onChange 立即生效，这是少数「NG 侧行为更好」的地方。
 * 注意别用内核事件 `config/changed`：那个只在**内核自己的** yunzai.yaml 变更时派发，
 * 插件配置的变更只能从 config.onChange 拿到。
 * @param {object} ctx 插件上下文
 */
function registerCron(ctx) {
  let disposeTask = null
  let current = ''

  const arm = () => {
    const cron = ctx.config.get().schedule?.cron
    if (!cron || cron === current) return
    disposeTask?.()
    current = cron
    disposeTask = ctx.cron(cron, () => runScheduledCheckin(), {
      name: CHECKIN_TASK_NAME,
      // 上一轮没跑完就跳过本轮：签到轮次可能长达几十分钟（浏览器过码），
      // 排队会让任务堆积并把内存吃光
      overlap: 'skip'
    })
    ctx.logger.info(`[relay-checkin-plugin] 定时签到已注册：${cron}`)
  }

  arm()
  const offConfig = ctx.config.onChange(() => arm())
  ctx.onDispose(() => {
    offConfig()
    disposeTask?.()
  })
}

export default definePlugin({
  name: 'relay-checkin',
  description: '中转站（new-api / Veloera / AnyRouter / AgentRouter / Sub2API / 薄荷）自动签到与余额查询',
  homepage: 'https://github.com/cchanlan/relay-checkin-plugin',
  configSchema,

  setup(ctx) {
    // 必须最先装宿主：models/* 全部通过适配层取 logger / 数据目录 / 配置 / 出图
    installHost(createNgHost(ctx))

    registerCommands(ctx)
    registerCron(ctx)

    // 凡是 ctx 之外自己开的资源都要登记，否则卸载后过码浏览器与定时器会留着
    // （出图的浏览器归渲染器插件管，不在这里）
    ctx.onDispose(async () => {
      disposeBinds()
      disposeRenderer()
      await closeBrowser()
      await disposeConfig()
    })

    ctx.logger.info('[relay-checkin-plugin] 中转站签到插件已就绪')
  }
})

