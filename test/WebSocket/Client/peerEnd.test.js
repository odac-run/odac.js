const {EventEmitter} = require('events')
const fs = require('fs')
const http = require('http')
const net = require('net')
const os = require('os')
const path = require('path')
const {WebSocketServer, WebSocketClient, READY_STATE} = require('../../../src/WebSocket.js')

// http.Server keeps sockets half-open (allowHalfOpen) and the upgrade detaches the handler that
// would end them, so a peer FIN without a CLOSE frame must be handled by the client itself.

function createSocket() {
  const socket = new EventEmitter()
  socket.pause = jest.fn()
  socket.resume = jest.fn()
  socket.write = jest.fn()
  socket.end = jest.fn()
  socket.destroy = jest.fn(() => socket.emit('close'))
  socket.writable = true
  return socket
}

describe('WebSocketClient peer end', () => {
  describe('with a stub socket', () => {
    let server

    beforeEach(() => {
      jest.useFakeTimers()
      server = new WebSocketServer()
    })

    afterEach(() => jest.useRealTimers())

    it('tears the connection down when the peer ends without a CLOSE frame', () => {
      const socket = createSocket()
      const client = new WebSocketClient(socket, server, 'c1')
      const onClose = jest.fn()
      client.on('close', onClose)
      client.resume()

      socket.emit('end')

      expect(socket.destroy).toHaveBeenCalledTimes(1)
      expect(client.readyState).toBe(READY_STATE.CLOSED)
      expect(onClose).toHaveBeenCalledTimes(1)
    })

    it('lets a server-initiated close finish flushing when the peer answers with FIN', () => {
      const socket = createSocket()
      const client = new WebSocketClient(socket, server, 'c1')
      client.resume()

      client.close(1000)
      socket.emit('end')

      expect(socket.end).toHaveBeenCalled()
      expect(socket.destroy).not.toHaveBeenCalled()

      jest.advanceTimersByTime(1000)
      expect(socket.destroy).toHaveBeenCalledTimes(1)
    })
  })

  describe.each([
    ['TCP', () => ({port: 0, host: '127.0.0.1'})],
    ['a unix socket', dir => ({path: path.join(dir, 'ws.sock')})]
  ])('over %s', (_, address) => {
    let dir
    let httpServer
    let wsServer
    let closed

    beforeEach(async () => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'odac-'))
      wsServer = new WebSocketServer()
      let onClosed
      closed = new Promise(resolve => (onClosed = resolve))
      wsServer.route('/ws', client => {
        client.on('close', onClosed)
        client.resume()
      })
      httpServer = http.createServer()
      httpServer.on('upgrade', (req, socket, head) => wsServer.handleUpgrade(req, socket, head, {Request: {data: {url: {}}}}))
      await new Promise(resolve => httpServer.listen(address(dir), resolve))
    })

    afterEach(async () => {
      for (const client of [...wsServer.clients.values()]) client.terminate()
      await new Promise(resolve => httpServer.close(resolve))
      fs.rmSync(dir, {recursive: true, force: true})
    })

    it('frees the connection as soon as the peer half-closes', async () => {
      const addr = httpServer.address()
      const socket = net.connect(typeof addr === 'string' ? {path: addr} : {port: addr.port, host: '127.0.0.1'})
      await new Promise(resolve => socket.once('connect', resolve))
      socket.write(
        'GET /ws HTTP/1.1\r\nHost: example.com\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
          'Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n'
      )
      await new Promise(resolve => socket.once('data', resolve))
      expect(wsServer.clientCount).toBe(1)

      const peerClosed = new Promise(resolve => socket.once('close', resolve))
      socket.on('error', () => {})
      socket.end()

      await closed
      await peerClosed
      expect(wsServer.clientCount).toBe(0)
    })
  })
})
