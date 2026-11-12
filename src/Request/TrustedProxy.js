const net = require('net')

// Named address groups accepted in `request.trustedProxies`.
// `private` covers the networks the ODAC proxy reaches apps through: Docker/Kubernetes bridge
// and overlay networks (RFC 1918, link-local, IPv6 ULA). Public addresses are never included,
// so a client connecting directly cannot impersonate the proxy.
const PRESETS = {
  loopback: [
    ['127.0.0.0', 8, 'ipv4'],
    ['::1', 128, 'ipv6']
  ],
  private: [
    ['10.0.0.0', 8, 'ipv4'],
    ['172.16.0.0', 12, 'ipv4'],
    ['192.168.0.0', 16, 'ipv4'],
    ['169.254.0.0', 16, 'ipv4'],
    ['fc00::', 7, 'ipv6'],
    ['fe80::', 10, 'ipv6']
  ]
}

const DEFAULT_TRUSTED = ['loopback', 'private']

const cache = new Map()

function addEntry(list, entry) {
  if (PRESETS[entry]) {
    for (const [address, prefix, type] of PRESETS[entry]) list.addSubnet(address, prefix, type)
    return true
  }

  const [address, prefixText] = String(entry).trim().split('/')
  const version = net.isIP(address)
  if (version === 0) return false

  const type = version === 4 ? 'ipv4' : 'ipv6'
  const max = version === 4 ? 32 : 128
  const prefix = prefixText === undefined ? max : Number(prefixText)
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > max) return false

  list.addSubnet(address, prefix, type)
  return true
}

function build(entries) {
  const list = new net.BlockList()
  for (const entry of entries) {
    if (!addEntry(list, entry)) console.error(`Odac Config Error: ignoring invalid request.trustedProxies entry "${entry}"`)
  }
  return list
}

/**
 * Decides whether a socket peer may supply the client address and TLS state via the
 * `X-Odac-Connection-*` headers.
 * Why: those headers are written by the ODAC proxy. Accepting them from any peer lets a client
 * that reaches the app directly choose its own IP, which defeats every IP-based control
 * (brute-force limits, form and session binding, auth anomaly detection) and fakes HTTPS.
 * @param {string|undefined} remoteAddress Socket peer address.
 * @param {string|string[]|undefined} configured `Config.request.trustedProxies`; IPs, CIDRs or
 *   the names `loopback`/`private`. Defaults to both names; an empty array trusts no one.
 * @returns {boolean}
 */
function isTrustedProxy(remoteAddress, configured) {
  if (!remoteAddress) return false

  const entries = configured === undefined || configured === null ? DEFAULT_TRUSTED : [].concat(configured)
  const key = entries.join(',')
  let list = cache.get(key)
  if (!list) {
    list = build(entries)
    cache.set(key, list)
  }

  const version = net.isIP(remoteAddress)
  if (version === 0) return false
  return list.check(remoteAddress, version === 4 ? 'ipv4' : 'ipv6')
}

module.exports = {isTrustedProxy}
