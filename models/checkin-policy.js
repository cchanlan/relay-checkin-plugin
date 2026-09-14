/**
 * 检查账号名是否命中跳过清单（纯函数便于测试）
 * accountName 通常为站点 host；skipHosts 按包含匹配，规则与 proxy.hosts 相同
 */
export function matchSkipHost(accountName, skipHosts) {
  if (!Array.isArray(skipHosts) || !skipHosts.length) return false
  return skipHosts.some(h => h && String(accountName).includes(String(h)))
}
