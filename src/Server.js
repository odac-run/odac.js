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
      console.log(`Odac Server running on \x1b]8;;http://127.0.0.1:${port}\x1b\\\x1b[4mhttp://127.0.0.1:${port}\x1b[0m\x1b]8;;\x1b\\.`)

      // Start session garbage collector (runs every hour, expires after 7 days)
      Odac.Storage.startSessionGC()

      for (let i = 0; i < numCPUs; i++) {
        cluster.fork()
      }

      cluster.on('exit', (worker, code, signal) => {
        cluster.fork()
      })
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
    }
  }
}
