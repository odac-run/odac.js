const http = require('http')
const cluster = require('node:cluster')
const os = require('node:os')

module.exports = {
  init: function () {
    let args = process.argv.slice(2)
    if (args[0] == 'framework' && args[1] == 'run') args = args.slice(2)
    let port = parseInt(args[0] ?? '1071')

    if (cluster.isPrimary) {
      const numCPUs = os.cpus().length
      let isShuttingDown = false
      
      console.log(`Odac Server running on \x1b]8;;http://127.0.0.1:${port}\x1b\\\x1b[4mhttp://127.0.0.1:${port}\x1b[0m\x1b]8;;\x1b\\.`)

      // Start session garbage collector (runs every hour, expires after 7 days)
      Odac.Storage.startSessionGC()

      for (let i = 0; i < numCPUs; i++) {
        cluster.fork()
      }

      cluster.on('exit', (worker, code, signal) => {
        // Don't restart workers during shutdown
        if (!isShuttingDown) {
          cluster.fork()
        }
      })

      // Graceful shutdown handler for primary
      const gracefulShutdown = (signal) => {
        if (isShuttingDown) return
        isShuttingDown = true
        
        console.log(`\n\x1b[33m[Shutdown]\x1b[0m ${signal} received, shutting down gracefully...`)
        
        // Disconnect all workers
        for (const id in cluster.workers) {
          cluster.workers[id].send('shutdown')
          cluster.workers[id].disconnect()
        }
        
        let workersAlive = Object.keys(cluster.workers).length
        
        cluster.on('exit', () => {
          workersAlive--
          if (workersAlive === 0) {
            console.log('\x1b[32m[Shutdown]\x1b[0m All workers stopped.')
            Odac.Storage.close()
            console.log('\x1b[32m[Shutdown]\x1b[0m Storage closed. Goodbye!')
            process.exit(0)
          }
        })
        
        // Force exit after 30 seconds
        setTimeout(() => {
          console.error('\x1b[31m[Shutdown]\x1b[0m Timeout! Forcing exit...')
          process.exit(1)
        }, 30000)
      }

      process.on('SIGTERM', () => gracefulShutdown('SIGTERM'))
      process.on('SIGINT', () => gracefulShutdown('SIGINT'))
      
    } else {
      const server = http.createServer((req, res) => {
        return Odac.Route.request(req, res)
      })

      server.on('upgrade', (req, socket, head) => {
        const id = `${Date.now()}${Math.random().toString(36).substr(2, 9)}`
        const param = Odac.instance(id, req, null)
        Odac.Route.handleWebSocketUpgrade(req, socket, head, param)
      })

      server.listen(port)

      // Graceful shutdown handler for worker
      process.on('message', (msg) => {
        if (msg === 'shutdown') {
          console.log(`\x1b[36m[Worker ${process.pid}]\x1b[0m Closing server...`)
          server.close(() => {
            console.log(`\x1b[36m[Worker ${process.pid}]\x1b[0m Server closed.`
            )
            process.exit(0)
          })
        }
      })
    }
  }
}
