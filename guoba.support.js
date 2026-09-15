import { getConfig, setConfigValues } from './models/config.js'
import { logger } from './host/index.js'

const divider = label => ({
  component: 'Divider',
  label,
  componentProps: { orientation: 'left', plain: true }
})

const sw = (field, label, bottomHelpMessage = '') => ({
  field,
  label,
  bottomHelpMessage,
  component: 'Switch',
  required: false
})

const input = (field, label, bottomHelpMessage = '', placeholder = '') => ({
  field,
  label,
  bottomHelpMessage,
  component: 'Input',
  required: false,
  componentProps: { placeholder }
})

const num = (field, label, { min = 0, max = 9999, addonAfter = '', placeholder = '', help = '' } = {}) => ({
  field,
  label,
  bottomHelpMessage: help,
  component: 'InputNumber',
  required: false,
  componentProps: { min, max, addonAfter, placeholder }
})

const tags = (field, label, bottomHelpMessage = '') => ({
  field,
  label,
  bottomHelpMessage,
  component: 'GTags',
  required: false,
  componentProps: { allowAdd: true, allowDel: true }
})

const schemas = [
  divider('定时签到'),
  sw('schedule.enable', '启用定时签到', '关闭后只能手动 #中转签到'),
  {
    field: 'schedule.cron',
    label: 'cron 表达式',
    bottomHelpMessage: '6 段（秒 分 时 日 月 周），默认每天 08:10：0 10 8 * * *。修改后需重启 Yunzai 才生效',
    component: 'EasyCron',
    required: false,
    componentProps: { placeholder: '0 10 8 * * *' }
  },
  num('schedule.jitterMinutes', '随机延迟', {
    max: 240,
    addonAfter: '分钟',
    placeholder: '10',
    help: '触发后随机延迟 0~N 分钟再开始，避免整点并发特征；0 = 不延迟'
  }),
  num('schedule.accountDelay.0', '账号间隔下限', {
    max: 600,
    addonAfter: '秒',
    placeholder: '5',
    help: '相邻两个账号签到之间的随机间隔最小值'
  }),
  num('schedule.accountDelay.1', '账号间隔上限', {
    max: 600,
    addonAfter: '秒',
    placeholder: '15',
    help: '随机间隔最大值，应不小于下限'
  }),
  num('schedule.concurrency', '并发用户数', {
    min: 1,
    max: 10,
    placeholder: '3',
    help: '同时处理的用户数（单用户内部仍逐账号串行）。人多时调大，服务器弱则调小，上限 10'
  }),

  divider('结果推送'),
  {
    field: 'push.mode',
    label: '推送方式',
    bottomHelpMessage:
      '固定群 = 全部用户结果合并转发到推送目标群（群管理在目标群发 #中转开启群推送 加入）；私聊 = 只发给本人；关闭 = 仅记录日志',
    component: 'Select',
    required: false,
    componentProps: {
      options: [
        { label: '固定群合并转发', value: 'group' },
        { label: '私聊本人', value: 'private' },
        { label: '不推送', value: 'off' }
      ],
      placeholder: '请选择推送方式'
    }
  },
  num('push.usersPerImage', '每张图用户数', {
    min: 1,
    max: 50,
    placeholder: '5',
    help: '群合并转发时每张图最多展示的用户数，超出自动分成多张图'
  }),

  divider('请求设置'),
  num('request.timeout', '请求超时', {
    min: 1,
    max: 300,
    addonAfter: '秒',
    placeholder: '15',
    help: '单次 HTTP 请求超时时间'
  }),
  num('request.retry', '重试次数', {
    max: 10,
    placeholder: '2',
    help: '网络错误重试次数。仅 GET/HEAD 等只读请求会重试，签到 POST 固定只发送一次'
  }),
  {
    field: 'request.userAgent',
    label: 'User-Agent',
    bottomHelpMessage: '接口请求使用的 UA，一般无需修改',
    component: 'Input',
    required: false,
    componentProps: { type: 'textarea', rows: 2, placeholder: 'Mozilla/5.0 ...' }
  },

  divider('地址安全策略'),
  sw('security.allowHttp', '允许 HTTP 站点', '默认只允许 HTTPS。确需使用明文 HTTP 站点时才开启，令牌会以明文传输'),
  tags(
    'security.allowedPrivateHosts',
    '放行的内网域名',
    '默认禁止本机/内网/链路本地地址。确需访问私有站点时填精确域名或 *.example.com，回车添加'
  ),

  divider('浏览器方案'),
  sw('browser.enable', '启用浏览器方案', 'AnyRouter 过阿里云 WAF、Turnstile / POW 站点自动降级签到所需，关闭后这类站点无法自动签到'),
  input(
    'browser.executablePath',
    '浏览器路径',
    '留空自动选择版本最高的系统 Chrome/Edge（跳过 snap 版 Chromium，它读不到本插件的档案目录），找不到才用 Puppeteer 自带 Chromium。Turnstile 要求浏览器较新，旧版 TRSS-Yunzai 建议显式填最新版 Chrome 路径',
    process.platform === 'win32'
      ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
      : '/usr/bin/google-chrome'
  ),
  num('browser.wafTimeoutSec', 'WAF 等待时长', {
    min: 5,
    max: 600,
    addonAfter: '秒',
    placeholder: '60',
    help: '等待阿里云 WAF 放行的最长时间，anyrouter 较慢，不够时可加大'
  }),
  sw(
    'browser.turnstileInteractive',
    '可见浏览器过 Turnstile',
    '在机器人运行设备上直接打开可见浏览器处理 Turnstile（独立持久档案，断开调试连接后由系统真实指针自动勾选）。'
    + 'Windows 与有桌面的机器直接用本机指针，无桌面 Linux 会自动拉起 Xvfb + xdotool，'
    + '需先执行 apt install xdotool（虚拟屏里的窗口没人看得见，缺了它会直接跳过验证并提示安装）。关闭后才使用无头模式'
  ),
  num('browser.turnstileInteractiveTimeoutSec', '可见接管超时', {
    min: 30,
    max: 600,
    addonAfter: '秒',
    placeholder: '120',
    help: '等待可见浏览器完成 Turnstile 的最长时间，范围 30~600'
  }),
  num('browser.turnstileTimeoutSec', '无头 Turnstile 超时', {
    min: 5,
    max: 120,
    addonAfter: '秒',
    placeholder: '30',
    help: '关闭可见接管后，无头尝试 Turnstile 的最长时间，范围 5~120'
  }),
  num('browser.powTimeoutSec', 'POW 计算超时', {
    min: 15,
    max: 300,
    addonAfter: '秒',
    placeholder: '120',
    help: 'NewAPI POW-Shield 计算并提交签到的最长时间，范围 15~300'
  }),
  num('browser.idleCloseSec', '空闲关闭', {
    min: 30,
    max: 3600,
    addonAfter: '秒',
    placeholder: '300',
    help: '浏览器空闲多久后自动关闭以释放内存'
  }),
  num('browser.maxConcurrentPages', '并发页面上限', {
    min: 1,
    max: 10,
    placeholder: '2',
    help: '全局同时打开的浏览器页面上限（每页约数十 MB 内存），超出的任务排队；上限 10'
  }),
  num('browser.slotWaitSec', '排队等待上限', {
    min: 30,
    max: 600,
    addonAfter: '秒',
    placeholder: '120',
    help: '排队等待浏览器空闲的最长时间，超时该账号本次判定失败。手动指令会自动覆盖此值，无需另配'
  }),

  divider('绑定流程'),
  num('bind.timeoutSec', '私聊补发超时', {
    min: 30,
    max: 1800,
    addonAfter: '秒',
    placeholder: '300',
    help: '只发 #中转添加 地址 后，等待私聊补发凭据的超时时间'
  }),
  num('bind.groupRecallSec', '群提示撤回', {
    max: 120,
    addonAfter: '秒',
    placeholder: '60',
    help: '群内绑定提示消息自动撤回秒数，防多人使用刷屏；0 = 不撤回。QQ 只允许撤回 2 分钟内的消息，最大 120'
  }),
  sw('recallAdd', '撤回添加指令', '群里使用 #中转添加 后尝试撤回用户消息（令牌敏感），需机器人有管理员权限'),

  divider('代理设置'),
  input(
    'proxy.url',
    '代理地址',
    'anyrouter.top 等站点国内网络无法直连时配置。支持 http 代理，可带账密 http://user:pass@host:port；留空 = 不使用代理',
    'http://127.0.0.1:7890'
  ),
  tags(
    'proxy.hosts',
    '走代理的域名',
    '需要走代理的站点域名关键字（按包含匹配），回车添加；留空 = 配置了代理后全部站点走代理'
  ),
  sw(
    'proxy.useForBrowser',
    '浏览器也走代理',
    '代理软件开启 TUN / 系统代理（如 Clash Verge TUN 模式）时，浏览器再显式指定代理可能形成环路导致页面打不开，这种情况请关闭，让浏览器直连由系统层透明转发（API 请求仍走代理）'
  )
]

export function supportGuoba() {
  return {
    pluginInfo: {
      name: 'relay-checkin-plugin',
      title: '中转站签到',
      author: '@Cat-bl',
      authorLink: 'https://github.com/Cat-bl',
      link: 'https://github.com/Cat-bl/relay-checkin-plugin',
      isV3: true,
      isV2: false,
      description: 'new-api / Veloera / AnyRouter / AgentRouter 中转站自动签到与余额查询',
      icon: 'mdi:calendar-check',
      iconColor: '#78b4ff'
    },
    configInfo: {
      schemas,
      getConfigData() {
        // 返回「默认 + 用户」合并结果，锅巴按点号路径取值
        return getConfig()
      },
      setConfigData(data, { Result }) {
        try {
          setConfigValues(data)
          return Result.ok({}, '保存成功~ cron 修改需重启 Yunzai 生效')
        } catch (err) {
          logger.error(`[relay-checkin-plugin] 锅巴保存配置失败: ${err?.message || err}`)
          return Result.error(`保存失败：${err?.message || err}`)
        }
      }
    }
  }
}
