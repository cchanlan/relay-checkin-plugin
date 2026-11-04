/**
 * TRSS-Yunzai 入口薄壳
 *
 * 指令逻辑全在 apps/checkin.js 的 RelayCheckinCore 里（与宿主无关），
 * 这里只做三件事：把共用的指令表铺成 TRSS 的 rule、挂定时任务、
 * 把 Yunzai 分发过来的 this.e / this.reply 交给 core。
 *
 * 只有 TRSS 会加载本文件（NG 走 ng/index.js），所以这里可以直接用全局 plugin 基类。
 */
import { COMMAND_RULES, CHECKIN_TASK_NAME, RelayCheckinCore } from './checkin.js'
import { getConfig } from '../models/config.js'
import { runScheduledCheckin } from '../models/scheduler.js'
import { SITE_CHECKIN_CRON, SITE_CHECKIN_TASK_NAME } from '../models/checkin-policy.js'

export default class RelayCheckinApp extends plugin {
  constructor() {
    super({
      name: '中转站签到',
      dsc: '中转站（new-api/Veloera 系）自动签到',
      event: 'message',
      priority: 5000,
      rule: COMMAND_RULES.map(({ reg, fnc, log }) => (
        log === false ? { reg, fnc, log } : { reg, fnc }
      ))
    })

    // 定时签到任务（cron 修改后需重启生效）
    this.task = [{
      name: CHECKIN_TASK_NAME,
      cron: getConfig().schedule.cron,
      fnc: () => runScheduledCheckin()
    }, {
      name: SITE_CHECKIN_TASK_NAME,
      cron: SITE_CHECKIN_CRON,
      log: false,
      fnc: () => runScheduledCheckin({ siteOnly: true })
    }]
  }
}

// 指令表里每个 fnc 在原型上生成一个转发方法：Yunzai 命中规则后调用 this[fnc]()，
// 这里为该次消息构造一个 core 实例。逐个手写 12 个同样的方法只会漏，故动态生成。
for (const { fnc } of COMMAND_RULES) {
  RelayCheckinApp.prototype[fnc] = function () {
    const core = new RelayCheckinCore({
      e: this.e,
      reply: (...args) => this.reply(...args)
    })
    return core[fnc]()
  }
}
