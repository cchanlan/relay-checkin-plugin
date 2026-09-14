import net from 'node:net'
import { lookup } from 'node:dns/promises'
import { getConfig } from './config.js'

const dnsCache = new Map()
const DNS_CACHE_MS = 60 * 1000

function normalizedHost(host) {
  return String(host || '').trim().replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '')
}

function matchesHost(host, pattern) {
  const p = normalizedHost(pattern)
  if (!p) return false
  if (p.startsWith('*.')) {
    const suffix = p.slice(1)
    return host.endsWith(suffix) && host.length > suffix.length
  }
  return host === p
}

function isAllowedPrivateHost(host, security) {
  const patterns = Array.isArray(security?.allowedPrivateHosts) ? security.allowedPrivateHosts : []
  return patterns.some(pattern => matchesHost(host, pattern))
}

function isPrivateIpv4(address) {
  const parts = address.split('.').map(Number)
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return true
  const [a, b] = parts
  return a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 0 || b === 168)) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
}

function mappedIpv4(address) {
  const lower = address.toLowerCase()
  const dotted = lower.match(/(?:^|:)ffff:(\d+\.\d+\.\d+\.\d+)$/)
  if (dotted) return dotted[1]
  const hex = lower.match(/(?:^|:)ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
  if (!hex) return null
  const high = parseInt(hex[1], 16)
  const low = parseInt(hex[2], 16)
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`
}

function isPrivateIpv6(address) {
  const lower = address.toLowerCase().split('%')[0]
  const mapped = mappedIpv4(lower)
  if (mapped) return isPrivateIpv4(mapped)
  if (lower === '::' || lower === '::1') return true
  if (/^(?:fc|fd)/.test(lower)) return true
  if (/^fe[89ab]/.test(lower)) return true
  if (/^ff/.test(lower)) return true
  if (/^2001:db8(?:\:|$)/.test(lower)) return true
  // 可公网路由的单播 IPv6 通常位于 2000::/3；其余地址默认拒绝。
  const first = parseInt(lower.split(':')[0] || '0', 16)
  return !Number.isFinite(first) || first < 0x2000 || first > 0x3fff
}

export function isPrivateAddress(address) {
  const ipVersion = net.isIP(normalizedHost(address))
  if (ipVersion === 4) return isPrivateIpv4(normalizedHost(address))
  if (ipVersion === 6) return isPrivateIpv6(normalizedHost(address))
  return false
}

function securityConfig(override) {
  return override ?? getConfig().security ?? {}
}

function parseHttpUrl(input, { originOnly = false, security = null } = {}) {
  const cfg = securityConfig(security)
  const url = new URL(String(input))
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('仅支持 HTTP/HTTPS 地址')
  if (url.protocol !== 'https:' && cfg.allowHttp !== true) throw new Error('仅允许 HTTPS 地址')
  if (url.username || url.password) throw new Error('站点地址不能包含用户名或密码')
  if (originOnly && (url.pathname !== '/' || url.search || url.hash)) {
    throw new Error('请填写站点根地址，不要附带路径、参数或锚点')
  }

  const host = normalizedHost(url.hostname)
  if (!host) throw new Error('站点地址缺少域名')
  if (isAllowedPrivateHost(host, cfg)) return url
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.home.arpa')) {
    throw new Error('不允许访问本机或内网域名')
  }
  if (net.isIP(host) && isPrivateAddress(host)) throw new Error('不允许访问本机、内网或保留地址')
  if (!net.isIP(host) && !host.includes('.')) throw new Error('不允许访问单标签内网域名')
  return url
}

export function normalizeAndValidateBaseUrl(input, security = null) {
  let value = String(input || '').trim()
  if (!/^[a-z][a-z\d+.-]*:\/\//i.test(value)) value = `https://${value}`
  const url = parseHttpUrl(value, { originOnly: true, security })
  return url.origin
}

async function resolveHost(host) {
  const cached = dnsCache.get(host)
  if (cached && Date.now() - cached.at < DNS_CACHE_MS) return await cached.value
  const value = lookup(host, { all: true, verbatim: true })
  dnsCache.set(host, { at: Date.now(), value })
  try {
    return await value
  } catch (err) {
    dnsCache.delete(host)
    throw err
  }
}

/**
 * 请求发出前重新解析域名并校验全部地址，避免仅在添加账号时做一次表面检查。
 */
export async function assertSafeRequestUrl(input, security = null) {
  const cfg = securityConfig(security)
  const url = parseHttpUrl(input, { security: cfg })
  const host = normalizedHost(url.hostname)
  if (isAllowedPrivateHost(host, cfg) || net.isIP(host)) return url

  let addresses
  try {
    addresses = await resolveHost(host)
  } catch (err) {
    throw new Error(`站点域名解析失败，请检查地址`)
  }
  if (!addresses.length) throw new Error('站点域名没有可用地址，请检查地址')
  const blocked = addresses.find(item => isPrivateAddress(item.address))
  if (blocked) throw new Error(`站点域名解析到了受保护地址，拒绝访问`)
  return url
}

