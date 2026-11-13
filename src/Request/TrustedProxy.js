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

// The ODAC server sets ODAC_APP=true for every app it runs. Read once: it cannot change after start.
const UNDER_ODAC = process.env.ODAC_APP === 'true'

const cache = new Map()

// Connections accepted on the ODAC proxy's unix socket (ODAC_PROXY_SOCKET). Keyed by the socket
// object so the mark dies with the connection.
const proxySockets = new WeakSet()

/**
 * Marks a connection accepted on the ODAC proxy's unix socket as trusted proxy traffic.
 * Why: a unix socket peer has no address, so the IP-based rule in isTrustedProxy() cannot
 * recognise it. Only processes that can reach the socket's directory can connect, which outside
 * the app's own container is the ODAC proxy alone.
 * @param {import('net').Socket} socket Connection from the proxy socket server's 'connection' event.
 */
function markProxySocket(socket) {
  if (socket && typeof socket === 'object') proxySockets.add(socket)
}

/**
 * Whether a connection arrived on the ODAC proxy's unix socket.
 * Why: decided by which listener accepted the connection rather than by an empty remoteAddress,
 * which a TCP socket also reports once it has been reset.
 * @param {import('net').Socket|undefined} socket
 * @returns {boolean}
 */
function isProxySocket(socket) {
  return !!socket && typeof socket === 'object' && proxySockets.has(socket)
}

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
 * Without an explicit list, an app under ODAC trusts loopback and private peers (the proxy's TCP
 * path); any other app trusts nobody, since no ODAC proxy writes these headers for it and a
 * private peer there is just as likely nginx, a Docker published port or a neighbour.
 * @param {string|undefined} remoteAddress Socket peer address.
 * @param {string|string[]|undefined} configured `Config.request.trustedProxies`; IPs, CIDRs or
 *   the names `loopback`/`private`. An explicit value always wins; an empty array trusts no one.
 * @param {boolean} [underOdac] Whether the app runs under an ODAC server (`ODAC_APP=true`).
 * @returns {boolean}
 */
function isTrustedProxy(remoteAddress, configured, underOdac = UNDER_ODAC) {
  if (!remoteAddress) return false

  const explicit = configured !== undefined && configured !== null
  if (!explicit && !underOdac) return false

  const entries = explicit ? [].concat(configured) : DEFAULT_TRUSTED
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

module.exports = {isProxySocket, isTrustedProxy, markProxySocket}
