const http = require('http')
const nodeCrypto = require('crypto')
const cluster = require('node:cluster')
const os = require('node:os')
const Stream = require('./Stream.js')

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

      const spawn = () => {
        const worker = cluster.fork()
        if (worker) startedAt.set(worker.id, Date.now())
      }

      for (let i = 0; i < numCPUs; i++) spawn()

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
    } else {
      const server = http.createServer((req, res) => {
        return Odac.Route.request(req, res)
      })

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
       *    Critical for sub-millisecond API responses.
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

      /**
       * 5. WebSocket upgrades run outside Route.request()'s try/catch, and Node
       *    strips its own socket error handler before emitting 'upgrade'. Any
       *    throw or socket reset here would otherwise escape as an uncaught
       *    exception and take down every connection on this worker.
       */
      server.on('upgrade', (req, socket, head) => {
        socket.on('error', () => socket.destroy())
        try {
          const id = nodeCrypto.randomBytes(16).toString('hex')
          const param = Odac.instance(id, req, null)
          Odac.Route.handleWebSocketUpgrade(req, socket, head, param)
        } catch (e) {
          console.error(JSON.stringify({level: 'ERROR', message: 'WebSocket upgrade failed', error: e.message}))
          socket.destroy()
        }
      })

      /**
       * 6. Without an 'error' listener a bind failure is an uncaught exception.
       *    A bind error cannot be fixed by retrying, so the worker exits with
       *    EXIT_FATAL and the primary stops the app with a clear error.
       */
      server.on('error', err => {
        console.error(JSON.stringify({level: 'ERROR', message: 'HTTP server error', code: err.code, error: err.message}))
        if (BIND_SYSCALLS.has(err.syscall)) process.exit(EXIT_FATAL)
      })

      server.listen(port)

      /**
       * GRACEFUL SHUTDOWN — WORKER PROCESS
       * ──────────────────────────────────
       * 1. Stop accepting new connections  (server.close)
       * 2. End connections that never finish on their own: idle keep-alive
       *    sockets, WebSocket clients (1001) and SSE streams. Any of them
       *    would keep server.close() from calling back until the primary's
       *    hard timeout, which skips the final write-buffer flush.
       * 3. Give in-flight requests SHUTDOWN_GRACE to finish, then cut them
       * 4. Release worker-scoped resources (IPC pending requests, DB pools)
       * 5. Exit 0
       */
      let isShuttingDown = false
      process.on('message', msg => {
        if (msg !== 'shutdown' || isShuttingDown) return
        isShuttingDown = true
        console.log(`\x1b[36m[Worker ${process.pid}]\x1b[0m Closing server...`)

        const graceTimer = setTimeout(() => server.closeAllConnections?.(), SHUTDOWN_GRACE)
        graceTimer.unref()

        server.close(async () => {
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
          process.exit(0)
        })

        server.closeIdleConnections?.()
        Odac.Route.wsServer.closeAll(1001, 'Server shutting down')
        Stream.closeAll()
      })
    }
  }
}
