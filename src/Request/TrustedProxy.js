const nodeCrypto = require('crypto')
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

// Key the ODAC proxy signs X-Odac-Connection-* with (ODAC_PROXY_KEY). Also set at container start.
const PROXY_KEY = process.env.ODAC_PROXY_KEY || ''

const SIGNATURE = /^t=(\d{1,15}),v1=([0-9a-f]{64})$/
const MAX_SKEW_SECONDS = 60

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

/**
 * Verifies the ODAC proxy's signature over a request's connection headers.
 * Why: on TCP, anything that reaches the app's port (a published port, a neighbour container) can
 * send `X-Odac-Connection-*`. Only the proxy holds the app's key, and method, host and URL are
 * signed with the values so a captured signature proves nothing on another route.
 * @param {import('http').IncomingMessage} req Request as received; headers not yet stripped.
 * @param {string} [key] The app's `ODAC_PROXY_KEY`.
 * @param {number} [now] Current time in milliseconds.
 * @returns {boolean}
 */
function hasProxySignature(req, key = PROXY_KEY, now = Date.now()) {
  if (!key) return false
  const match = SIGNATURE.exec(req.headers['x-odac-connection-signature'] ?? '')
  if (!match) return false
  if (Math.abs(now / 1000 - Number(match[1])) > MAX_SKEW_SECONDS) return false
  const signed = [
    'odac-connection-v1',
    match[1],
    req.method,
    req.headers.host ?? '',
    req.url,
    req.headers['x-odac-connection-remoteaddress'] ?? '',
    req.headers['x-odac-connection-ssl'] ?? ''
  ].join('\n')
  const expected = nodeCrypto.createHmac('sha256', key).update(signed).digest()
  return nodeCrypto.timingSafeEqual(expected, Buffer.from(match[2], 'hex'))
}

/**
 * Decides whether a request's `X-Odac-Connection-*` headers were written by the ODAC proxy.
 * Why: the proxy socket and a valid signature prove it outright. An app holding a key knows its
 * proxy signs, so unsigned TCP traffic is someone else even from a private peer, unless the
 * operator listed that peer in `trustedProxies`. Without a key (an ODAC server older than signing,
 * or a container started before it) the network rule in isTrustedProxy() still applies.
 * @param {import('http').IncomingMessage} req
 * @param {import('net').Socket|undefined} socket The connection the request arrived on.
 * @param {string|string[]|undefined} configured `Config.request.trustedProxies`.
 * @param {{underOdac?: boolean, key?: string, now?: number}} [options] Overrides for tests.
 * @returns {boolean}
 */
function isFromOdacProxy(req, socket, configured, {underOdac = UNDER_ODAC, key = PROXY_KEY, now = Date.now()} = {}) {
  if (isProxySocket(socket)) return true
  if (hasProxySignature(req, key, now)) return true
  const explicit = configured !== undefined && configured !== null
  if (key && !explicit) return false
  return isTrustedProxy(socket?.remoteAddress, configured, underOdac)
}

module.exports = {hasProxySignature, isFromOdacProxy, isProxySocket, isTrustedProxy, markProxySocket}
