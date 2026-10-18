/**
 * 代理重试行为测试：TLS 握手被拒时非幂等请求可安全重发，挂起超时必须结束且不重发
 *
 * 场景全部用本机假代理构造，不访问外网：
 *   1. 代理回 "HTTP/1.1 200 Connection Established" 后灌一条 TLS alert(40) handshake failure
 *      → 握手没完成，请求一个字节都没发出去 → POST 应重试（默认 2 次，共 3 次连接）
 *   2. 同样的代理，GET 在 retry=0 下不应获得「请求未发出」预算 → 只连 1 次
 *   3. 代理收到 CONNECT 后不回任何东西 → 超时兜底必须结束请求，且非幂等请求不重发
 *
 * 运行：node test/proxy-retry.mjs（在插件根目录）
 */
import assert from 'node:assert'
import net from 'node:net'

const ROOT = new URL('..', import.meta.url)
const load = spec => import(new URL(spec, ROOT).href)

// ---- mock 全局环境 ----
global.logger = {
  info: () => {}, mark: () => {}, warn: () => {}, error: (...a) => console.error('[logger.error]', ...a)
}
global.Bot = { uin: 10000 }

const { installHost } = await load('host/index.js')
const { createTrssHost } = await load('host/trss.js')

const ALERT40 = Buffer.from([0x15, 0x03, 0x03, 0x00, 0x02, 0x02, 0x28])

/** 假代理：回 200 后灌一条 TLS alert(40)，模拟边缘节点拒绝握手 */
function startAlertProxy() {
  const state = { connects: 0 }
  const server = net.createServer(socket => {
    socket.once('data', () => {
      state.connects++
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      setTimeout(() => {
        socket.write(ALERT40)
        setTimeout(() => socket.destroy(), 120)
      }, 20)
    })
    socket.on('error', () => {})
  })
  return { state, server }
}

/** 假代理：收到 CONNECT 后什么都不回，模拟 CONNECT 阶段挂起 */
function startHangProxy() {
  const state = { connects: 0 }
  const server = net.createServer(socket => {
    state.connects++
    socket.on('error', () => {})
  })
  return { state, server }
}

async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return server.address().port
}

const base = createTrssHost()
/** 用真配置做底，只把代理指向本机假代理，并把重试次数压到 0 便于计数 */
function installOn(port) {
  installHost({
    ...base,
    getConfig: () => {
      const cfg = base.getConfig()
      return {
        ...cfg,
        request: { ...cfg.request, timeout: 5, retry: 0 },
        proxy: { ...cfg.proxy, url: `http://127.0.0.1:${port}`, hosts: ['example.com'] }
      }
    }
  })
}

const alertProxy = startAlertProxy()
const alertPort = await listen(alertProxy.server)
installOn(alertPort)
const { request } = await load('models/adapters/common.js')

// 1) 非幂等 POST：握手被拒 → 重试 2 次，并抛人话
alertProxy.state.connects = 0
let err = null
try {
  await request('https://example.com/api/user/sign_in', { method: 'POST', body: {} })
} catch (e) {
  err = e
}
assert.equal(alertProxy.state.connects, 3, 'POST 应在握手失败后重试 2 次（共 3 次连接）')
assert.match(String(err?.message || ''), /TLS 握手阶段拒绝/, '应向用户说明是握手阶段被拒')

// 2) GET 在 retry=0 下拿到 0 预算 → 只连 1 次
alertProxy.state.connects = 0
err = null
try {
  await request('https://example.com/api/user/self')
} catch (e) {
  err = e
}
assert.equal(alertProxy.state.connects, 1, 'GET 不应获得额外重试预算')

// 3) CONNECT 挂起：超时必须结束请求，非幂等请求不重发
const hangProxy = startHangProxy()
const hangPort = await listen(hangProxy.server)
installOn(hangPort)
const { request: requestAfterReinstall } = await load('models/adapters/common.js')
hangProxy.state.connects = 0
const startedAt = Date.now()
err = null
try {
  await requestAfterReinstall('https://example.com/api/user/sign_in', { method: 'POST', body: {}, timeoutMs: 800 })
} catch (e) {
  err = e
}
const elapsed = Date.now() - startedAt
assert.equal(hangProxy.state.connects, 1, '挂起超时不应重发')
assert.match(String(err?.message || ''), /超时/, '应报超时')
assert.ok(elapsed < 3000, `超时应在 ~800ms 内结束，实际 ${elapsed}ms`)

alertProxy.server.close()
hangProxy.server.close()
console.log('代理重试行为 OK（握手失败重试 / GET 不重试 / 挂起超时兜底）')
// 宿主装了配置监听器，事件循环不会自己空，测试跑完直接退出
process.exit(0)
