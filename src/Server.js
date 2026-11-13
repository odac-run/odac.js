const http = require('http')
const nodeCrypto = require('crypto')
const cluster = require('node:cluster')
const os = require('node:os')
const Stream = require('./Stream.js')
const ProxySocket = require('./Server/ProxySocket.js')

// How long a worker lets in-flight requests (downloads, slow uploads) finish
// after shutdown starts before cutting them. Kept well under the primary's
// 30s hard timeout so the final write-buffer flush still runs afterwards.
const SHUTDOWN_GRACE = 10000

// Respawn backoff. A worker that dies within STABLE_UPTIME of starting is
// treated as a startup crash: each consecutive one doubles the respawn delay
// from RESPAWN_BASE up to RESPAWN_MAX, so a broken deploy cannot fork in a
// tight loop. A worker that ran longer is replaced at once and resets it.
const RESPAWN_BASE = 1000
const RESPAWN_MAX = 30000
const STABLE_UPTIME = 10000

// Exit code (EX_CONFIG) a worker uses for errors a respawn cannot fix, such
// as a port already in use. The primary stops the app instead of looping.
const EXIT_FATAL = 78
// A port conflict surfaces as 'listen' in a single process but as 'bind' in a
// cluster worker, where the primary creates the listening handle.
const BIND_SYSCALLS = new Set(['listen', 'bind'])

// A worker draining after an uncaught exception has no primary-imposed
// deadline, so it bounds its own: SHUTDOWN_GRACE for in-flight requests plus
// headroom for closing IPC, database and storage.
const CRASH_DRAIN_TIMEOUT = SHUTDOWN_GRACE + 5000

function describeError(err) {
  return {error: err?.message ?? String(err), stack: err?.stack}
}

/**
 * Logs a promise rejection that no code handled.
 *
 * Why: under Node's default (--unhandled-rejections=throw) one missing
 * catch in application code (an async Odac.setInterval callback, a
 * fire-and-forget query) kills the process along with every connection it
 * serves. A rejection leaves no half-applied synchronous state behind, so
 * logging it and carrying on is safe.
 * @param {*} reason
 */
function logUnhandledRejection(reason) {
  console.error(JSON.stringify({level: 'ERROR', message: 'Unhandled promise rejection', pid: process.pid, ...describeError(reason)}))
}

function logUncaughtException(err) {
  console.error(JSON.stringify({level: 'FATAL', message: 'Uncaught exception, shutting down', pid: process.pid, ...describeError(err)}))
}

/**
 * Number of worker processes the cluster runs.
 *
 * Why: the primary forks this many workers, and database pools are sized
 * from the same figure so the cluster as a whole stays under the server's
 * connection limit.
 * @returns {number}
 */
function workerCount() {
  return Odac.Config.debug ? 1 : os.cpus().length
}

module.exports = {
  workerCount,
  init: function () {
    let args = process.argv.slice(2)
    if (args[0] == 'framework' && args[1] == 'run') args = args.slice(2)
    let port = parseInt(args[0])
    if (isNaN(port)) port = parseInt(process.env.PORT || '1071')

    if (cluster.isPrimary) {
      const numCPUs = workerCount()
      let isShuttingDown = false

      const mode = Odac.Config.debug ? '\x1b[33mDevelopment\x1b[0m' : '\x1b[32mProduction\x1b[0m'
      console.log(
        `Odac Server running on \x1b]8;;http://127.0.0.1:${port}\x1b\\\x1b[4mhttp://127.0.0.1:${port}\x1b[0m\x1b]8;;\x1b\\ in ${mode} mode.`
      )

      // Start session garbage collector (runs every hour, expires after 7 days)
      Odac.Storage.startSessionGC()

      const startedAt = new Map()
      let crashStreak = 0

      // The primary owns the proxy socket's listening handle, so it alone clears a stale file
      // and decides whether workers serve the socket. Workers get the resolved path, or an
      // empty value for TCP only, so none of them touches the path on its own.
      let proxySocket = null
      let proxySocketId = null
      let forkEnv

      const spawn = () => {
        const worker = cluster.fork(forkEnv)
        if (worker) startedAt.set(worker.id, Date.now())
      }

      const start = () => {
        if (isShuttingDown) return
        for (let i = 0; i < numCPUs; i++) spawn()
      }

      if (process.env[ProxySocket.ENV]) {
        cluster.on('listening', (worker, address) => {
          if (!proxySocket || address?.addressType !== -1 || address.address !== proxySocket) return
          ProxySocket.identify(proxySocket).then(id => {
            if (id) proxySocketId = id
          })
        })
        ProxySocket.prepare()
          .catch(() => null)
          .then(target => {
            proxySocket = target
            forkEnv = {[ProxySocket.ENV]: target ?? ''}
            start()
          })
      } else {
        start()
      }

      cluster.on('exit', (worker, code) => {
        const uptime = Date.now() - (startedAt.get(worker.id) ?? 0)
        startedAt.delete(worker.id)
        if (isShuttingDown) return

        if (code === EXIT_FATAL) {
          console.error(JSON.stringify({level: 'ERROR', message: 'Worker hit a fatal error, stopping ODAC', worker: worker.id}))
          return gracefulShutdown('FATAL', 1)
        }

        crashStreak = uptime >= STABLE_UPTIME ? 0 : crashStreak + 1
        const delay = crashStreak === 0 ? 0 : Math.min(RESPAWN_BASE * 2 ** (crashStreak - 1), RESPAWN_MAX)
        if (delay > 0) {
          console.error(
            JSON.stringify({
              level: 'WARN',
              message: 'Worker crashed during startup, delaying respawn',
              worker: worker.id,
              code,
              delayMs: delay
            })
          )
        }
        setTimeout(() => {
          if (!isShuttingDown) spawn()
        }, delay)
      })

      /**
       * GRACEFUL SHUTDOWN — PRIMARY PROCESS
       * ────────────────────────────────────
       * Shutdown order (deterministic, sequential):
       *   1. Stop accepting new work       → Cron, session GC
       *   2. Drain active workers           → send 'shutdown', disconnect, wait
       *   3. Release shared resources       → Database, IPC, Storage
       *   4. Exit 0
       *
       * A 30-second hard timeout protects against hung workers or I/O.
       */
      const gracefulShutdown = async (signal, exitCode = 0) => {
        if (isShuttingDown) return
        isShuttingDown = true

        console.log(`\n\x1b[33m[Shutdown]\x1b[0m ${signal} received, shutting down gracefully...`)

        // Force exit safety net — must be set immediately
        const forceTimer = setTimeout(() => {
          console.error('\x1b[31m[Shutdown]\x1b[0m Timeout! Forcing exit...')
          process.exit(1)
        }, 30000)
        forceTimer.unref()

        // Phase 1: Stop schedulers so no new work is queued
        Odac.Route.stopCron()
        Odac.Storage.stopSessionGC()

        // Phase 2: Gracefully drain all workers
        await new Promise(resolve => {
          const workerIds = Object.keys(cluster.workers)
          let workersAlive = workerIds.length

          if (workersAlive === 0) return resolve()

          cluster.on('exit', () => {
            workersAlive--
            if (workersAlive <= 0) resolve()
          })

          for (const id of workerIds) {
            const worker = cluster.workers[id]
            if (worker) {
              worker.send('shutdown')
              worker.disconnect()
            }
          }
        })

        console.log('\x1b[32m[Shutdown]\x1b[0m All workers stopped.')

        if (proxySocket) await ProxySocket.release(proxySocket, proxySocketId)

        // Phase 3: Release shared resources (order matters: DB → IPC → Storage)
        // Database.close() runs the WriteBuffer final flush, which reads the
        // buffered writes from the IPC store and falls back to an LMDB
        // checkpoint in Storage. Both must still be open when it runs.
        try {
          await Odac.Database.close()
        } catch (e) {
          console.error(`\x1b[31m[Shutdown]\x1b[0m Error closing Database: ${e.message}`)
        }
        try {
          await Odac.Ipc.close()
        } catch (e) {
          console.error(`\x1b[31m[Shutdown]\x1b[0m Error closing IPC: ${e.message}`)
        }
        try {
          await Odac.Storage.close()
        } catch (e) {
          console.error(`\x1b[31m[Shutdown]\x1b[0m Error closing Storage: ${e.message}`)
        }

        console.log('\x1b[32m[Shutdown]\x1b[0m Resources released. Goodbye!')
        clearTimeout(forceTimer)
        process.exit(exitCode)
      }

      process.on('SIGTERM', () => gracefulShutdown('SIGTERM'))
      process.on('SIGINT', () => gracefulShutdown('SIGINT'))

      // The primary runs cron jobs, the session GC and the memory IPC store.
      // A stray rejection is logged; an uncaught exception leaves state
      // unknown, so the app still flushes and exits instead of running on.
      process.on('unhandledRejection', logUnhandledRejection)
      process.on('uncaughtException', err => {
        logUncaughtException(err)
        gracefulShutdown('uncaughtException', 1)
      })
    } else {
      const handleRequest = (req, res) => Odac.Route.request(req, res)

      /**
       * WebSocket upgrades run outside Route.request()'s try/catch, and Node
       * strips its own socket error handler before emitting 'upgrade'. Any
       * throw or socket reset here would otherwise escape as an uncaught
       * exception and take down every connection on this worker.
       */
      const handleUpgrade = (req, socket, head) => {
        socket.on('error', () => socket.destroy())
        try {
          const id = nodeCrypto.randomUUID()
          const param = Odac.instance(id, req, null)
          Odac.Route.handleWebSocketUpgrade(req, socket, head, param)
        } catch (e) {
          console.error(JSON.stringify({level: 'ERROR', message: 'WebSocket upgrade failed', error: e.message}))
          socket.destroy()
        }
      }

      // The TCP port and the proxy socket serve the same app, so both get the same handlers
      // and tuning.
      const createServer = () => {
        const server = http.createServer(handleRequest)

        /**
         * ENTERPRISE PERFORMANCE CONFIGURATION
         * ------------------------------------
         * 1. Keep-Alive: Set higher than the upstream Load Balancer/Proxy (usually 60s).
         *    This prevents the "502 Bad Gateway" race condition where Node closes
         *    an idle connection while the proxy attempts to reuse it.
         */
        server.keepAliveTimeout = 65000 // 65 seconds
        server.headersTimeout = 66000 // 66 seconds (Must be > keepAliveTimeout)

        /**
         * 2. Low Latency: Disable Nagle's Algorithm.
         *    We want to send data immediately, even if the packet is small.
         *    Critical for sub-millisecond API responses. A no-op on unix sockets.
         */
        server.on('connection', socket => {
          socket.setNoDelay(true)
        })

        /**
         * 3. Connection Rotation: Force reset after 10k requests.
         *    - Helps with Load Balancing (clients are forced to reconnect and potentially pick a new pod/worker).
         *    - Mitigates long-term memory leaks in the TLS/Socket layer.
         */
        server.maxRequestsPerSocket = 10000

        /**
         * 4. Hard Timeout: Kill connection if request processing (headers + body) takes too long.
         *    - Defaults to 0 (unlimited) or 5min in older Node.
         *    - 30s is more than enough for an API; fail fast if the client is stuck.
         */
        server.requestTimeout = 30000 // 30 seconds

        server.on('upgrade', handleUpgrade)
        return server
      }

      const server = createServer()

      /**
       * 5. Without an 'error' listener a bind failure is an uncaught exception.
       *    A bind error cannot be fixed by retrying, so the worker exits with
       *    EXIT_FATAL and the primary stops the app with a clear error.
       */
      server.on('error', err => {
        console.error(JSON.stringify({level: 'ERROR', message: 'HTTP server error', code: err.code, error: err.message}))
        if (BIND_SYSCALLS.has(err.syscall)) process.exit(EXIT_FATAL)
      })

      /**
       * 6. The ODAC proxy's unix socket, when ODAC_PROXY_SOCKET is set. It opens
       *    before the TCP port so the server finds it as soon as the app is up.
       *    The proxy falls back to TCP on any failed dial, so a socket error is
       *    logged and never fatal.
       */
      const servers = [server]
      const proxySocket = ProxySocket.socketPath()
      if (proxySocket) {
        const socketServer = createServer()
        ProxySocket.listen(socketServer, proxySocket)
        servers.push(socketServer)
      }

      server.listen(port)

      /**
       * GRACEFUL SHUTDOWN — WORKER PROCESS
       * ──────────────────────────────────
       * 1. Stop accepting new connections on every listener (server.close)
       * 2. End connections that never finish on their own: idle keep-alive
       *    sockets, WebSocket clients (1001) and SSE streams. Any of them
       *    would keep server.close() from calling back until the primary's
       *    hard timeout, which skips the final write-buffer flush.
       * 3. Give in-flight requests SHUTDOWN_GRACE to finish, then cut them
       * 4. Release worker-scoped resources (IPC pending requests, DB pools)
       * 5. Exit 0 (1 when the drain follows an uncaught exception)
       *
       * The proxy socket file is left alone: in a cluster its handle belongs
       * to the primary and siblings may still serve it.
       */
      let isShuttingDown = false
      const drain = exitCode => {
        if (isShuttingDown) return
        isShuttingDown = true
        console.log(`\x1b[36m[Worker ${process.pid}]\x1b[0m Closing server...`)

        const graceTimer = setTimeout(() => {
          for (const s of servers) s.closeAllConnections?.()
        }, SHUTDOWN_GRACE)
        graceTimer.unref()

        let open = servers.length
        const onClosed = async () => {
          if (--open > 0) return
          clearTimeout(graceTimer)
          try {
            await Odac.Ipc.close()
          } catch {
            /* best-effort */
          }
          try {
            await Odac.Database.close()
          } catch {
            /* best-effort */
          }
          try {
            // Session writes are committed asynchronously; flush them before exiting.
            await Odac.Storage.close()
          } catch {
            /* best-effort */
          }
          console.log(`\x1b[36m[Worker ${process.pid}]\x1b[0m Server closed.`)
          process.exit(exitCode)
        }

        for (const s of servers) s.close(onClosed)
        for (const s of servers) s.closeIdleConnections?.()
        Odac.Route.wsServer.closeAll(1001, 'Server shutting down')
        Stream.closeAll()
      }

      process.on('message', msg => {
        if (msg === 'shutdown') drain(0)
      })

      /**
       * PROCESS-LEVEL SAFETY NET — WORKER
       * ─────────────────────────────────
       * Framework dispatch points (route handlers, WebSocket and IPC
       * callbacks) contain their own errors; this covers application code
       * they cannot see, such as timer callbacks and detached promises.
       *  - Unhandled rejection: logged, the worker keeps serving.
       *  - Uncaught exception: process state is unknown, so the worker drains
       *    like a normal shutdown and exits 1; the primary forks a
       *    replacement. CRASH_DRAIN_TIMEOUT bounds a drain that hangs.
       */
      process.on('unhandledRejection', logUnhandledRejection)
      process.on('uncaughtException', err => {
        logUncaughtException(err)
        setTimeout(() => process.exit(1), CRASH_DRAIN_TIMEOUT).unref()
        drain(1)
      })
    }
  }
}
