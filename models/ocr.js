import { spawn } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { killProcessTree } from './native.js'

const pluginDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const scriptPath = path.join(pluginDir, 'scripts', 'ocr_captcha.py')

/**
 * 挑选运行 ocr_captcha.py 的解释器。
 * 宿主的 PATH 里往往是别的项目的虚拟环境（本机就是 AstrBot 的 .venv），
 * 装了 ddddocr 也照样 ModuleNotFoundError，所以优先用插件自带的 .venv。
 * 顺序：环境变量 RELAY_CHECKIN_PYTHON → 插件 .venv → PATH 里的 python3/python。
 */
function resolvePython() {
  const fromEnv = process.env.RELAY_CHECKIN_PYTHON?.trim()
  if (fromEnv) return fromEnv
  const candidates = [
    path.join(pluginDir, '.venv', 'bin', 'python'),
    path.join(pluginDir, '.venv', 'Scripts', 'python.exe')
  ]
  for (const p of candidates) {
    if (existsSync(p)) return p
  }
  return process.platform === 'win32' ? findWindowsPython() : 'python3'
}

/**
 * Windows 上 PATH 里的 python.exe 很可能是「应用商店存根」——微软放在
 * %LOCALAPPDATA%\\Microsoft\\WindowsApps 下的占位文件，执行它只会弹出商店页面、
 * 永不返回，表现为每次 OCR 都超时。所以自己遍历 PATH 跳过存根，
 * 都没有才交给 py launcher（官方安装包写进 System32，知道所有已注册的 Python）。
 */
export function findWindowsPython(env = process.env, exists = candidate => {
  try {
    const stat = statSync(candidate)
    return stat.isFile() && stat.size > 0
  } catch {
    return false
  }
}) {
  // Windows 的 PATH 分隔符恒为分号；写死而不用 path.delimiter，
  // 才能在别的平台上对这段逻辑做测试（那边的分隔符是冒号，会把盘符切开）
  for (const dir of String(env.PATH || env.Path || '').split(';').filter(Boolean)) {
    if (/WindowsApps/i.test(dir)) continue
    for (const name of ['python.exe', 'python3.exe']) {
      const candidate = path.join(dir, name)
      if (exists(candidate)) return candidate
    }
  }
  return 'py'
}

// ddddocr 首次调用要加载两个 onnx 模型，正常几秒内出结果。
// 依赖不全（缺 onnxruntime / 模型文件损坏）时 python 可能卡在 import 不退出，
// 而 captchaFallback 会连试 15 次、定时任务路径又没有 guardHang 兜底，
// 一次挂起就会让 runScheduledCheckin 的 running 永久为 true（此后每天都跳过签到），
// 因此这里必须自带硬超时并杀掉子进程。
const DEFAULT_TIMEOUT_MS = 45000

/**
 * python 的 traceback 直接透传会把整段栈塞进签到结果、再渲染进推送图，
 * 所以缺依赖这类常见错误压成一行可执行的提示，其余只保留最后一行。
 */
function describeStderr(stderr, python) {
  const raw = String(stderr || '').trim()
  if (!raw) return '无输出'
  const missing = raw.match(/ModuleNotFoundError: No module named '([^']+)'/)
  if (missing) {
    return `缺少 python 依赖 ${missing[1]}，请执行：${python} -m pip install ddddocr Pillow`
  }
  return raw.split('\n').filter(Boolean).pop().slice(0, 200)
}

/**
 * 调用 scripts/ocr_captcha.py（ddddocr）识别图形验证码。
 * @param {Buffer} image 验证码图片二进制
 * @param {{timeoutMs?: number}} opts 超时时间（毫秒），到时杀进程并 reject
 * @returns {Promise<string>} 识别出的字符（可能为空串）
 */
export function ocrCaptcha(image, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const python = resolvePython()
    const child = spawn(python, [scriptPath], { stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    let settled = false
    const finish = fn => (...args) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn(...args)
    }
    const done = finish(resolve)
    const fail = finish(reject)

    // unref 避免超时后的定时器把 Yunzai 进程留在事件循环里
    const timer = setTimeout(() => {
      // SIGKILL 而非 SIGTERM：卡在 onnxruntime 初始化的 python 可能不响应 TERM。
      // 走进程树是因为 Windows 上解释器可能是 py launcher，它真正干活的
      // python.exe 是子进程，只杀 launcher 会留下一个吃着内存的孤儿
      killProcessTree(child.pid)
      fail(new Error('验证码识别超时，请稍后重试'))
    }, timeoutMs)
    timer.unref?.()

    child.stdout.on('data', chunk => { out += chunk })
    child.stderr.on('data', chunk => { err += chunk })
    child.on('error', e => {
      fail(e?.code === 'ENOENT'
        ? new Error(`找不到 python 解释器 ${python}，${process.platform === 'win32'
          ? '请安装 Python 并勾选 Add to PATH'
          : '请安装 python3'}，或用环境变量 RELAY_CHECKIN_PYTHON 指定路径`)
        : e)
    })
    child.on('close', code => {
      if (code === 0) return done(out.trim())
      fail(new Error(`验证码识别失败，请稍后重试`))
    })
    child.stdin.on('error', () => child.kill())
    child.stdin.end(image)
  })
}
