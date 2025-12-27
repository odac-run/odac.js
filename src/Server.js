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

      // Garbage Collector: Remove sessions older than 7 days
      setInterval(() => {
        const now = Date.now()
        const expiration = 7 * 24 * 60 * 60 * 1000
        let count = 0
        
        for (const { key, value } of Odac.KV.getRange({ start: 'sess:', end: 'sess:~', snapshot: false })) {
           if (key.endsWith(':_created')) {
             if (now - value > expiration) {
               const prefix = key.replace(':_created', '')
               for (const subKey of Odac.KV.getKeys({ start: prefix, end: prefix + '~' })) {
                 Odac.KV.remove(subKey)
               }
               count++
             }
           }
        }
        if (count > 0) console.log(`[GC] Cleaned ${count} expired sessions.`)
      }, 1000 * 60 * 60) // Run every hour

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
