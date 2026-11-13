const fs = require('fs')
const net = require('net')
const os = require('os')
const path = require('path')

// Unix socket paths are limited to about 104 bytes, so tests use a short temp directory.
function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'odac-'))
}

function listenOn(server, target) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(target, () => {
      server.off('error', reject)
      resolve(server)
    })
  })
}

function close(server) {
  return new Promise(resolve => server.close(() => resolve()))
}

// A socket file nobody listens on, as a container restart leaves behind. Closing a server
// unlinks its path, so the live file is moved away first and survives the close.
async function staleSocket(target) {
  const server = await listenOn(net.createServer(), `${target}.live`)
  fs.renameSync(`${target}.live`, target)
  await close(server)
  return target
}

module.exports = {close, listenOn, staleSocket, tempDir}
