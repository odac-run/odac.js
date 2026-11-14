const fs = require('node:fs')
const net = require('node:net')
const path = require('node:path')
const {markProxySocket} = require('../Request/TrustedProxy.js')

const ENV = 'ODAC_PROXY_SOCKET'

// A stale socket refuses a connection at once; one that accepts, or does not answer within
// this window, belongs to a live process and is left alone.
const PROBE_TIMEOUT = 1000

function log(level, message, fields) {
  console.error(JSON.stringify({level, message, ...fields}))
}

/**
 * Unix socket path the ODAC proxy dials for this app, read from ODAC_PROXY_SOCKET.
 * Why: the ODAC server sets it for bridge-networked containers; the socket skips the TCP stack
 * between proxy and app. Absent or empty means TCP only, exactly as before the socket existed.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string|null} Normalized absolute path, or null when no socket should be served.
 */
function socketPath(env = process.env) {
  const value = env[ENV]
  if (!value) return null
  if (!path.isAbsolute(value) || value.includes('\0')) {
    log('WARN', 'Ignoring ODAC_PROXY_SOCKET: it must be an absolute path, serving on TCP only', {path: value})
    return null
  }
  return path.resolve(value)
}

function isLive(target) {
  return new Promise(resolve => {
    const probe = net.connect({path: target})
    const done = live => {
      clearTimeout(timer)
      probe.destroy()
      resolve(live)
    }
    const timer = setTimeout(() => done(true), PROBE_TIMEOUT)
    probe.once('connect', () => done(true))
    probe.once('error', () => done(false))
  })
}

/**
 * Removes what a previous run left at the socket path so the new listener can bind there.
 * Why: a restarted container keeps the old socket file, and binding over it fails with
 * EADDRINUSE. A symlink is removed as a link (unlink never follows it); a socket is removed only
 * when nothing answers on it; anything else is refused so a misconfigured path cannot delete
 * a regular file. Runs once, in the cluster primary, before any worker listens.
 * @param {string} target Path from socketPath().
 * @returns {Promise<boolean>} Whether the path is free to bind.
 */
async function clearStale(target) {
  let stat
  try {
    stat = await fs.promises.lstat(target)
  } catch (err) {
    if (err.code === 'ENOENT') return true
    log('ERROR', 'Proxy socket path is not usable, serving on TCP only', {path: target, code: err.code, error: err.message})
    return false
  }

  if (stat.isSocket()) {
    if (await isLive(target)) {
      log('ERROR', 'Another process is listening on the proxy socket, serving on TCP only', {path: target})
      return false
    }
  } else if (!stat.isSymbolicLink()) {
    log('ERROR', 'Proxy socket path holds something that is not a socket, serving on TCP only', {path: target})
    return false
  }

  try {
    await fs.promises.unlink(target)
    return true
  } catch (err) {
    if (err.code === 'ENOENT') return true
    log('ERROR', 'Could not remove the stale proxy socket, serving on TCP only', {path: target, code: err.code, error: err.message})
    return false
  }
}

/**
 * Resolves the proxy socket the workers should serve, clearing a stale file first.
 * Why: in a cluster the primary owns every listening handle, so it is the only process that
 * may touch the path; a worker unlinking it could delete the socket its siblings serve.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<string|null>} Path to serve, or null for TCP only. Never rejects.
 */
async function prepare(env = process.env) {
  const target = socketPath(env)
  if (!target) return null
  return (await clearStale(target)) ? target : null
}

/**
 * Serves `server` on the proxy socket in addition to the TCP port.
 * Why: every connection it accepts is marked as proxy traffic for the trust check in Request,
 * and a failure only logs: the proxy falls back to TCP per request, so the socket must never
 * take the app down.
 * @param {import('http').Server} server Server sharing the TCP server's handlers.
 * @param {string} target Path from socketPath().
 */
function listen(server, target) {
  server.on('connection', markProxySocket)
  server.on('error', err => {
    const message = server.listening ? 'Proxy socket server error' : 'Could not listen on the proxy socket, serving on TCP only'
    log('ERROR', message, {path: target, code: err.code, error: err.message})
  })
  try {
    server.listen(target)
  } catch (err) {
    log('ERROR', 'Could not listen on the proxy socket, serving on TCP only', {path: target, code: err.code, error: err.message})
  }
}

/**
 * Identity of the socket file at `target`, taken once a worker reports it is listening.
 * Why: release() must only delete the file this app bound, never one created after it.
 * @param {string} target
 * @returns {Promise<{dev: bigint, ino: bigint}|null>}
 */
async function identify(target) {
  try {
    const stat = await fs.promises.lstat(target, {bigint: true})
    return stat.isSocket() ? {dev: stat.dev, ino: stat.ino} : null
  } catch {
    return null
  }
}

/**
 * Removes the socket file at shutdown if it is still the one this app bound.
 * Why: closing the last listening handle normally unlinks it already; this covers the cases
 * where it did not, so a stopped app leaves no socket the server could mistake for a live one.
 * The dev/ino match alone cannot prove ownership: Linux hands a freed inode number straight to
 * the next file, so a socket a new instance bound after this one has the same identity. Once
 * every worker has stopped, a socket that still answers belongs to another process and is never
 * removed; one with this identity that nobody serves is stale either way.
 * @param {string} target
 * @param {{dev: bigint, ino: bigint}|null} identity From identify().
 */
async function release(target, identity) {
  if (!identity) return
  try {
    const stat = await fs.promises.lstat(target, {bigint: true})
    if (!stat.isSocket() || stat.dev !== identity.dev || stat.ino !== identity.ino) return
    if (await isLive(target)) return
    await fs.promises.unlink(target)
  } catch (err) {
    if (err.code !== 'ENOENT') log('WARN', 'Could not remove the proxy socket', {path: target, code: err.code, error: err.message})
  }
}

module.exports = {ENV, identify, listen, prepare, release, socketPath}
