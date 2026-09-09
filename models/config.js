import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import YAML from 'yaml'
import chokidar from 'chokidar'
import { logger, dataDir, currentHost } from '../host/index.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export const PLUGIN_PATH = path.join(__dirname, '..')

/** TRSS 宿主的数据目录：插件目录下的 data/（NG 用 ctx.dataDir，见 host/ng.js） */
export const TRSS_DATA_PATH = path.join(PLUGIN_PATH, 'data')

/**
 * 数据目录。以前是顶层常量 DATA_PATH，改成函数是因为 NG 下它来自注入的 ctx，
 * 模块求值时还不知道
 */
export function dataPath() {
  return dataDir()
}

/** 配置文件路径（仅 TRSS 宿主使用；NG 的配置由内核按 schema 管理） */
export function configPath() {
  return path.join(dataPath(), 'config.yaml')
}

/**
 * 原子写入用的重命名：Windows 下杀软/同步盘可能短暂锁住文件导致 EPERM，短暂重试
 */
export function renameWithRetry(from, to, tries = 5) {
  for (let i = 0; ; i++) {
    try {
      fs.renameSync(from, to)
      return
    } catch (err) {
      if (i >= tries - 1 || !['EPERM', 'EBUSY', 'EACCES'].includes(err.code)) throw err
      const end = Date.now() + 50
      while (Date.now() < end) { /* 等待锁释放 */ }
    }
  }
}

export const DEFAULT_CONFIG = {
  schedule: {
    enable: true,
    cron: '0 10 8 * * *',
    jitterMinutes: 10,
    accountDelay: [5, 15],
    concurrency: 3
  },
  push: {
    mode: 'group',
    usersPerImage: 5
  },
  request: {
    timeout: 15,
    retry: 2,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
  },
  security: {
    allowHttp: false,
    allowedPrivateHosts: []
  },
  browser: {
    enable: true,
    executablePath: '',
    wafTimeoutSec: 60,
    turnstileTimeoutSec: 30,
    turnstileInteractive: true,
    turnstileInteractiveTimeoutSec: 120,
    // NewAPI POW-Shield 计算与提交的最长时间（秒）
    powTimeoutSec: 120,
    idleCloseSec: 300,
    maxConcurrentPages: 2,
    slotWaitSec: 120
  },
  bind: {
    timeoutSec: 300,
    groupRecallSec: 60
  },
  proxy: {
    url: '',
    hosts: ['anyrouter'],
    useForBrowser: true
  },
  recallAdd: true,
  skip: {
    hosts: []
  }
}

let configCache = null
let configWatcher = null

/**
 * 首次启动时把 config_default/config.yaml 复制到 data/config.yaml
 */
function ensureConfigFiles() {
  const DATA_PATH = dataPath()
  const CONFIG_PATH = configPath()
  if (!fs.existsSync(DATA_PATH)) {
    fs.mkdirSync(DATA_PATH, { recursive: true })
  }
  const defaultConfigPath = path.join(PLUGIN_PATH, 'config_default', 'config.yaml')
  if (!fs.existsSync(CONFIG_PATH) && fs.existsSync(defaultConfigPath)) {
    fs.copyFileSync(defaultConfigPath, CONFIG_PATH)
    logger.info('[relay-checkin-plugin] 已从 config_default 生成默认配置')
  }
}

/**
 * 深合并：用户配置缺项或类型不符时回落到默认值
 */
function mergeConfig(def, user) {
  if (user === null || user === undefined) return def
  if (Array.isArray(def) || typeof def !== 'object') return user
  if (typeof user !== 'object' || Array.isArray(user)) return def
  const out = { ...def }
  for (const key of Object.keys(user)) {
    out[key] = key in def ? mergeConfig(def[key], user[key]) : user[key]
  }
  return out
}

/**
 * 找出用户配置里缺少的默认配置键（点号路径），用于升级后补齐新增配置项
 */
function findMissingKeys(def, user, path = []) {
  const missing = []
  if (def === null || typeof def !== 'object' || Array.isArray(def)) return missing
  if (user === null || typeof user !== 'object' || Array.isArray(user)) return missing
  for (const key of Object.keys(def)) {
    if (!(key in user)) {
      missing.push([...path, key].join('.'))
    } else {
      missing.push(...findMissingKeys(def[key], user[key], [...path, key]))
    }
  }
  return missing
}

/**
 * 插件更新新增配置项时同步到 data/config.yaml：
 * 以 config_default 模板（含注释）为底，写回用户已有的值（含用户自定义键），
 * 用户改过的值全部保留，仅补上缺失的新增项
 */
function syncNewConfigKeys(userConfig) {
  const CONFIG_PATH = configPath()
  const defaultConfigPath = path.join(PLUGIN_PATH, 'config_default', 'config.yaml')
  if (!fs.existsSync(defaultConfigPath)) return
  const missing = findMissingKeys(DEFAULT_CONFIG, userConfig)
  if (!missing.length) return

  try {
    const doc = YAML.parseDocument(fs.readFileSync(defaultConfigPath, 'utf-8'))
    const apply = (obj, prefix) => {
      for (const [key, value] of Object.entries(obj)) {
        const p = [...prefix, key]
        if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
          apply(value, p)
        } else {
          doc.setIn(p, value)
        }
      }
    }
    apply(userConfig, [])
    const tmp = CONFIG_PATH + '.tmp'
    fs.writeFileSync(tmp, doc.toString())
    renameWithRetry(tmp, CONFIG_PATH)
    logger.mark(`[relay-checkin-plugin] 配置文件已补充新增项: ${missing.join(', ')}`)
  } catch (err) {
    logger.error(`[relay-checkin-plugin] 配置文件同步新增项失败: ${err.message}`)
  }
}

/**
 * 锅巴等外部面板写回配置：以现有 data/config.yaml 为底（保留用户注释与自定义键），
 * 按点号路径逐项覆盖后原子写入。路径中的纯数字段视为数组下标（如 schedule.accountDelay.0）
 * @param {Record<string, any>} values 形如 { 'schedule.enable': true, 'proxy.hosts': ['anyrouter'] }
 */
export function setConfigValues(values) {
  ensureConfigFiles()

  const CONFIG_PATH = configPath()
  const raw = fs.existsSync(CONFIG_PATH) ? fs.readFileSync(CONFIG_PATH, 'utf-8') : ''
  const doc = YAML.parseDocument(raw)
  // 空文件 parseDocument 得到 null contents，先补成映射再 setIn
  if (!doc.contents) doc.contents = doc.createNode({})

  for (const [keyPath, value] of Object.entries(values || {})) {
    if (!keyPath) continue
    const parts = keyPath.split('.').map(p => (/^\d+$/.test(p) ? Number(p) : p))
    doc.setIn(parts, value)
  }

  const tmp = CONFIG_PATH + '.tmp'
  fs.writeFileSync(tmp, doc.toString({ lineWidth: 0 }))
  renameWithRetry(tmp, CONFIG_PATH)
  // chokidar 的 change 事件有延迟，这里立即让缓存失效，保证保存后马上生效
  configCache = null
}

/**
 * 读取配置。实际实现由宿主决定：
 * TRSS 是下面的 readYamlConfig（data/config.yaml + 热更新），
 * NG 是 ctx.config.get()（内核按 configSchema 管理，面板保存即生效）
 */
export function getConfig() {
  return currentHost().getConfig()
}

/**
 * TRSS 宿主的配置读取：data/config.yaml（带缓存与 chokidar 热更新）
 */
export function readYamlConfig() {
  if (configCache) return configCache

  ensureConfigFiles()

  const CONFIG_PATH = configPath()
  let userConfig = {}
  let parseOk = true
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      userConfig = YAML.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')) || {}
    }
  } catch (err) {
    parseOk = false
    logger.error(`[relay-checkin-plugin] 配置解析失败，使用默认配置: ${err.message}`)
  }
  // 配置能正常解析时才回写补齐，避免把用户写坏的文件直接覆盖掉
  if (parseOk) syncNewConfigKeys(userConfig)
  configCache = mergeConfig(DEFAULT_CONFIG, userConfig)

  if (!configWatcher) {
    configWatcher = chokidar.watch(CONFIG_PATH)
    configWatcher.on('change', () => {
      configCache = null
      logger.mark('[relay-checkin-plugin] 配置文件已更新')
    })
  }

  return configCache
}

/**
 * 关掉配置文件监听并清空缓存
 *
 * NG 会在插件卸载时调用（内核要求「卸载真的归还资源」，chokidar 的 watcher
 * 属于 ctx 之外自己开的资源，必须登记到 onDispose）。TRSS 下用不上但无害。
 */
export async function disposeConfig() {
  configCache = null
  if (configWatcher) {
    const watcher = configWatcher
    configWatcher = null
    try {
      await watcher.close()
    } catch {
      // 已关闭或从未真正启动，忽略
    }
  }
}

/**
 * 用默认值补全一份外部配置（NG 宿主用）
 *
 * NG 的 configSchema 已经保证了结构，但用户手改 YAML、或插件升级引入新键时
 * 仍可能缺项，这里统一用 DEFAULT_CONFIG 兜一层，语义与 TRSS 侧一致。
 * @param {object} external 外部配置
 * @returns {object} 合并后的配置
 */
export function withDefaults(external) {
  return mergeConfig(DEFAULT_CONFIG, external || {})
}
