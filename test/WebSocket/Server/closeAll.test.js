const {EventEmitter} = require('events')
const {WebSocketServer} = require('../../../src/WebSocket.js')

// Upgraded sockets are invisible to server.closeAllConnections() and keep
// server.close() from calling back. Shutdown has to close them itself, with
// 1001 (Going Away) so clients know to reconnect to another worker.

function createSocket() {
  const socket = new EventEmitter()
  socket.pause = jest.fn()
  socket.resume = jest.fn()
  socket.write = jest.fn()
  socket.end = jest.fn()
  socket.destroy = jest.fn()
  socket.writable = true
  return socket
}

function closeCode(socket) {
  const frame = socket.write.mock.calls.map(c => c[0]).find(f => Buffer.isBuffer(f) && (f[0] & 0x0f) === 0x8)
  return frame ? frame.readUInt16BE(2) : null
}

function connect(server) {
  const socket = createSocket()
  server.handleUpgrade({url: '/chat', headers: {'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ=='}}, socket, Buffer.alloc(0), global.Odac)
  return socket
}

describe('WebSocketServer.closeAll()', () => {
  let server

  beforeEach(() => {
    jest.useFakeTimers()
    global.Odac = {Request: {data: {url: {}}}}
    server = new WebSocketServer()
    server.route('/chat', () => {})
  })

  afterEach(() => {
    jest.useRealTimers()
    delete global.Odac
  })

  it('closes every client with 1001 Going Away', () => {
    const a = connect(server)
    const b = connect(server)

    server.closeAll()

    expect(closeCode(a)).toBe(1001)
    expect(closeCode(b)).toBe(1001)
    expect(server.clientCount).toBe(0)
  })

  it('destroys sockets whose peer never completes the close handshake', () => {
    const a = connect(server)

    server.closeAll()
    jest.runOnlyPendingTimers()

    expect(a.destroy).toHaveBeenCalled()
  })

  it('is a no-op without clients', () => {
    expect(() => server.closeAll()).not.toThrow()
  })
})
