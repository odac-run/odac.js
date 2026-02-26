const http = require('http')
const nodeCrypto = require('crypto')
const cluster = require('node:cluster')
const os = require('node:os')

module.exports = {
  init: function () {
    let args = process.argv.slice(2)
    if (args[0] == 'framework' && args[1] == 'run') args = args.slice(2)
    let port = parseInt(args[0])
    if (isNaN(port)) port = parseInt(process.env.PORT || '1071')

    if (cluster.isPrimary) {
      const numCPUs = Odac.Config.debug ? 1 : os.cpus().length
      let isShuttingDown = false

      const mode = Odac.Config.debug ? '\x1b[33mDevelopment\x1b[0m' : '\x1b[32mProduction\x1b[0m'
      console.log(
        `Odac Server running on \x1b]8;;http://127.0.0.1:${port}\x1b\\\x1b[4mhttp://127.0.0.1:${port}\x1b[0m\x1b]8;;\x1b\\ in ${mode} mode.`
      )

      // Start session garbage collector (runs every hour, expires after 7 days)
      Odac.Storage.startSessionGC()

      for (let i = 0; i < numCPUs; i++) {
        cluster.fork()
      }

      cluster.on('exit', () => {
        // Don't restart workers during shutdown
        if (!isShuttingDown) {
          cluster.fork()
        }
      })

      /**
       * GRACEFUL SHUTDOWN — PRIMARY PROCESS
       * ────────────────────────────────────
       * Shutdown order (deterministic, sequential):
       *   1. Stop accepting new work       → Cron, session GC
       *   2. Drain active workers           → send 'shutdown', disconnect, wait
       *   3. Release shared resources       → IPC, Database, Storage
       *   4. Exit 0
       *
       * A 30-second hard timeout protects against hung workers or I/O.
       */
      const gracefulShutdown = async signal => {
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

        // Phase 3: Release shared resources (order matters: IPC → DB → Storage)
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
        Odac.Storage.close()

        console.log('\x1b[32m[Shutdown]\x1b[0m Resources released. Goodbye!')
        clearTimeout(forceTimer)
        process.exit(0)
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

      server.on('upgrade', (req, socket, head) => {
        const id = nodeCrypto.randomBytes(16).toString('hex')
        const param = Odac.instance(id, req, null)
        Odac.Route.handleWebSocketUpgrade(req, socket, head, param)
      })

      server.listen(port)

      /**
       * GRACEFUL SHUTDOWN — WORKER PROCESS
       * ──────────────────────────────────
       * 1. Stop accepting new connections  (server.close)
       * 2. Release worker-scoped resources (IPC pending requests, DB pools)
       * 3. Exit 0
       */
      process.on('message', async msg => {
        if (msg === 'shutdown') {
          console.log(`\x1b[36m[Worker ${process.pid}]\x1b[0m Closing server...`)

          server.close(async () => {
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
            console.log(`\x1b[36m[Worker ${process.pid}]\x1b[0m Server closed.`)
            process.exit(0)
          })
        }
      })
    }
  }
}
