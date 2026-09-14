# relay-checkin-plugin

中转站自动签到插件。手动签到 / 每日定时 / 余额查询，结果出图，数据按用户隔离，群内所有人可用。

支持 **new-api、Veloera 及同源魔改站、AnyRouter、AgentRouter、Sub2API**，站点类型自动识别。
宿主支持 **TRSS-Yunzai**（OneBot v11）与 **[Yunzai NG](https://github.com/Yunzai-NG/yunzai-ng)**。

> **本仓库是 Fork**，上游 [Cat-bl/relay-checkin-plugin](https://github.com/Cat-bl/relay-checkin-plugin)；
> 两个镜像同步更新：[GitHub](https://github.com/cchanlan/relay-checkin-plugin) · [GitCode](https://gitcode.com/ccxhan/relay-checkin-plugin)（国内更快）

## 相对上游新增

- 同一份代码兼容 Yunzai NG（宿主依赖收进 `host/` 适配层）
- 新增 **Sub2API** 站点与 `#中转添加刷新令牌`：邮箱密码或 refresh_token 绑定，续期不开浏览器
- **Turnstile 改为断开调试连接后由页面自治过码**（CDP 连着必被判自动化），三个平台都能自动勾选：
  Windows 走 user32 真实指针，有桌面的用本机指针，无桌面 Linux 自动拉 Xvfb + xdotool
- **图形验证码自动识别**（ddddocr），答错自动换码重试
- 过码失败定性到具体原因（内核过旧 / 出口 IP 被风控 / 站点挂 WAF）并留档截图
- 浏览器档案占用自愈、锅巴配置面板、new-api 网页会话（`authMode: session`）

## 安装

在 Yunzai 根目录执行（三个源内容相同，任选一个，推荐国内的）：

**gitcode（国内直连最快）**
```bash
git clone --depth=1 https://gitcode.com/ccxhan/relay-checkin-plugin ./plugins/relay-checkin-plugin
```

**gitee（国内）**
```bash
git clone --depth=1 https://gitee.com/longhengmu/relay-checkin-plugin ./plugins/relay-checkin-plugin
```

**GitHub**
```bash
git clone --depth=1 https://github.com/cchanlan/relay-checkin-plugin ./plugins/relay-checkin-plugin
```

重启即可，依赖蹭 Yunzai 自带的。

### 人机验证（Turnstile）的运行环境

过码要在真实显示环境里用**系统级指针**勾选复选框（CDP 注入的点击一律被判自动化），
各平台的准备工作不同：

| 系统 | 要装什么 | 说明 |
| --- | --- | --- |
| 无桌面 Linux | `apt install -y xvfb xdotool` | 自动拉虚拟屏，全程无人值守 |
| 有桌面 Linux | `apt install -y xdotool` | 用本机桌面，勾选时会短暂占用鼠标 |
| Windows 10 / 11 | 无需安装 | 用系统自带 PowerShell 调 user32 指针。要在**已登录的桌面会话**里跑 Yunzai，装成 Windows 服务会起不来浏览器 |
| macOS | — | 没有免安装的指针工具，需要自己在弹出的窗口里点一下 |

还必须有较新的 Chrome / Edge：Turnstile 拒绝过旧内核，而 Puppeteer 自带的 Chromium 往往是数年前的
构建（实测 Chromium 101 点完只回 `600010`，换 Chrome 152 立刻签发 token）。装好后插件自动选版本最高
的那个，也可用 `browser.executablePath` 指定。Debian / Ubuntu 服务器：

```bash
curl -fsSL https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb -o /tmp/chrome.deb && apt install -y /tmp/chrome.deb
```

### 图形验证码（可选）

部分 NewAPI 魔改站签到要填图形码，装了才能自动识别：

```bash
cd plugins/relay-checkin-plugin
python3 -m venv .venv && .venv/bin/python -m pip install ddddocr   # Linux / macOS
py -m venv .venv && .venv\Scripts\pip install ddddocr              # Windows
```

Python 3.14 上 `venv` 建完可能没有 `pip`（自带的旧版 pip 与 3.14 不兼容），装了
[uv](https://github.com/astral-sh/uv) 就换 3.13 环境：
`uv venv --python 3.13 .venv && uv pip install --python .venv/bin/python ddddocr`

### 装在 Yunzai NG 上

在 NG 主目录执行（三个源内容相同，任选一个）：

**gitcode（国内直连最快）**
```bash
git clone --depth=1 https://gitcode.com/ccxhan/relay-checkin-plugin ./plugins/relay-checkin-plugin
```

**gitee（国内）**
```bash
git clone --depth=1 https://gitee.com/longhengmu/relay-checkin-plugin ./plugins/relay-checkin-plugin
```

**GitHub**
```bash
git clone --depth=1 https://github.com/cchanlan/relay-checkin-plugin ./plugins/relay-checkin-plugin
```

装依赖（NG 侧没有现成依赖可蹭）：

```bash
# puppeteer 只用于过码，出图走内核渲染器，可跳过 Chromium 下载
PUPPETEER_SKIP_DOWNLOAD=1 npm install --prefix ./plugins/relay-checkin-plugin
```

NG 侧另有面板配置与 `ctx.cron` 定时（改 cron 立即生效），出图交给渲染器插件。

## 指令

```
#中转添加 站点地址 [令牌]        令牌绑定，群里可只发地址、私聊补令牌
#中转添加cookie 站点地址 session  只认网页会话的魔改站
#中转添加邮箱 站点地址 邮箱 密码   AgentRouter / Sub2API
#中转添加刷新令牌 站点地址 令牌     Sub2API，过不去码时用

#中转签到 [序号]     不带序号签全部
#中转查询           余额
#中转列表           各账号余额、今日状态、定时开关
#中转删除 序号
#中转定时 开/关 [序号]

#中转开启群推送 / #中转关闭群推送    群管理用，把本群设为定时结果推送目标
#中转帮助  #中转插件更新
```

同一站点可绑多个账号（按站点用户 ID 区分）；添加成功会自动签一次。所有 `#中转xxx` 都兼容
`#中转站xxx` 写法。群里发含令牌的指令会自动尝试撤回，列表图里令牌打码。

## 每日抽奖

兼容同源福利中心接口的NewAPI站点，会在签到结束后自动领取每日抽奖。
不限定站点域名，无需额外指令；添加账号、手动签到和定时签到都支持。

[签到与抽奖批注明细示例（模拟数据）](docs/images/daily-lottery.png)

- 只处理每日抽奖，不调用可能扣余额的幸运签到、猜数字、老虎机或水果机。
- 同一站点只显示一条记录，批注分行列出签到和每日抽奖各自的结果、奖励；原签到状态和“本次”奖励列不变，余额显示最终余额。抽奖不参与签到奖励的余额差复核。
- 每次先读站点的今日抽奖状态（兼容`Done`和`done`）；已抽过不再提交。
- 状态不明确，或站点明确提示抽奖需扣费时，不发起领取。
- 领取POST始终单次；响应丢失时只复查状态，无法确认则显示“抽奖未确认”。
- 没有福利接口的站点保持原展示，探测结果缓存6小时；临时网络错误不会永久禁用探测。
- 如果同时配置了跳过清单，命中的账号不执行每日抽奖；余额查询、账号列表不会触发抽奖。

## 配置

改 `data/config.yaml`，或装了锅巴在面板里改（保存即生效，保留注释）。分组如下：

| 段 | 常用项 |
| --- | --- |
| `schedule` | `cron` 定时时间、`jitterMinutes` 随机抖动、`accountDelay` 账号间隔、`concurrency` 并发 |
| `push` | `mode`（`group` 群合并转发 / `private` 私聊 / `off`）、`usersPerImage` 一张图几个人 |
| `browser` | `turnstileTimeoutSec` 过码超时、`maxConcurrentPages` 页面并发、`executablePath` 指定 Chrome |
| `request` | `timeout`、`retry`、`userAgent` |
| `bind` | `timeoutSec` 私聊补令牌的等待时长、`groupRecallSec` 群内撤回延迟 |
| `proxy` | `url` 与 `hosts`（只对指定站点走代理）、`useForBrowser`；出口 IP 被站点风控时也靠它换出口 |
| `security` | `allowHttp`、`allowedPrivateHosts` |

## 已知限制

- 过不去的码只能换出口：机房 IP 常被判高风险（凭据照常签发、站点侧一律不通过，手动点也一样），
  整站挂滑动验证（如阿里云 WAF）的站点纯 HTTP 与浏览器都过不去 —— 两者都要 `proxy.url` 配非机房出口
- Turnstile 升级到人工挑战时仍需接管，插件会把截图发出来
- AnyRouter 等纯浏览器站的余额走缓存，不是每次实时刷
- 一次性 refresh_token 轮换后立刻落盘，但若同时手动操作可能撞车，重绑即可
- 上游与本 fork 都不保证站点接口稳定，站点改版可能需要跟进

仅供学习交流，账号风险自负。

