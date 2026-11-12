const {EventEmitter} = require('events')
const {WebSocketServer} = require('../../../src/WebSocket.js')

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

function upgradeRequest(url = '/chat') {
  return {url, headers: {'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ=='}}
}

/** Reads the status code out of the last CLOSE frame the server wrote. */
function lastCloseCode(socket) {
  const frames = socket.write.mock.calls.map(c => c[0]).filter(f => Buffer.isBuffer(f) && (f[0] & 0x0f) === 0x8)
  const frame = frames.at(-1)
  return frame ? frame.readUInt16BE(2) : null
}

const flush = () => new Promise(resolve => setImmediate(resolve))

/**
 * The route handler (auth check, middleware, user code) is async. Its failure
 * must close that one connection with 1011, never surface as an unhandled
 * rejection that terminates the worker and every connection on it.
 */
describe('WebSocketServer.handleUpgrade()', () => {
  let server
  let onUnhandled

  beforeEach(() => {
    jest.spyOn(console, 'error').mockImplementation(() => {})
    server = new WebSocketServer()
    onUnhandled = jest.fn()
    process.on('unhandledRejection', onUnhandled)
    global.Odac = {Request: {data: {url: {}}}}
  })

  afterEach(() => {
    process.removeListener('unhandledRejection', onUnhandled)
    jest.restoreAllMocks()
    delete global.Odac
  })

  it('closes with 1011 when the async handler rejects', async () => {
    server.route('/chat', async () => {
      throw new Error('db down')
    })
    const socket = createSocket()

    server.handleUpgrade(upgradeRequest(), socket, Buffer.alloc(0), global.Odac)
    await flush()

    expect(onUnhandled).not.toHaveBeenCalled()
    expect(lastCloseCode(socket)).toBe(1011)
    expect(socket.end).toHaveBeenCalled()
  })

  it('closes with 1011 when the handler throws synchronously', () => {
    server.route('/chat', () => {
      throw new Error('sync bug')
    })
    const socket = createSocket()

    expect(() => server.handleUpgrade(upgradeRequest(), socket, Buffer.alloc(0), global.Odac)).not.toThrow()
    expect(lastCloseCode(socket)).toBe(1011)
  })

  it('drops the failed client from the server', async () => {
    server.route('/chat', async () => {
      throw new Error('db down')
    })

    server.handleUpgrade(upgradeRequest(), createSocket(), Buffer.alloc(0), global.Odac)
    await flush()

    expect(server.clientCount).toBe(0)
  })

  it('leaves a successful connection open', async () => {
    server.route('/chat', async client => client.resume())
    const socket = createSocket()

    server.handleUpgrade(upgradeRequest(), socket, Buffer.alloc(0), global.Odac)
    await flush()

    expect(lastCloseCode(socket)).toBeNull()
    expect(server.clientCount).toBe(1)
  })

  it('answers 404 for an unknown path', () => {
    const socket = createSocket()

    server.handleUpgrade(upgradeRequest('/nope'), socket, Buffer.alloc(0), global.Odac)

    expect(socket.write).toHaveBeenCalledWith('HTTP/1.1 404 Not Found\r\n\r\n')
    expect(socket.destroy).toHaveBeenCalled()
  })
})

describe('WebSocketServer.handleUpgrade() handshake checks', () => {
  let server

  const upgrade = (headers = {}, route = 'www', url = '/chat') => {
    const socket = createSocket()
    const req = {url, headers: {'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', host: 'example.com', ...headers}}
    server.handleUpgrade(req, socket, Buffer.alloc(0), {Request: {route, data: {url: {}}}})
    return socket
  }
  const response = socket => String(socket.write.mock.calls[0][0])

  beforeEach(() => {
    server = new WebSocketServer()
  })

  afterEach(() => server.closeAll())

  it('answers with a single subprotocol when the client offers several', () => {
    server.route('/chat', () => {})
    const socket = upgrade({'sec-websocket-protocol': 'chat.v2, odac-token-abc'})
    expect(response(socket)).toContain('Sec-WebSocket-Protocol: odac-token-abc\r\n')
    expect(response(socket)).not.toContain('chat.v2')
  })

  it('prefers a protocol the route supports', () => {
    server.route('/chat', () => {}, {protocols: ['chat.v2']})
    const socket = upgrade({'sec-websocket-protocol': 'chat.v1,chat.v2,odac-token-abc'})
    expect(response(socket)).toContain('Sec-WebSocket-Protocol: chat.v2\r\n')
  })

  it('refuses a cross-origin browser handshake', () => {
    server.route('/chat', () => {})
    const socket = upgrade({origin: 'https://evil.example'})
    expect(response(socket)).toMatch(/^HTTP\/1\.1 403/)
    expect(socket.destroy).toHaveBeenCalled()
  })

  it('accepts same-origin, origin-less and allowlisted handshakes', () => {
    server.route('/chat', () => {})
    server.route('/public', () => {}, {origins: ['https://partner.example']})
    expect(response(upgrade({origin: 'https://example.com'}))).toMatch(/^HTTP\/1\.1 101/)
    expect(response(upgrade({}))).toMatch(/^HTTP\/1\.1 101/)
    expect(response(upgrade({origin: 'https://partner.example'}, 'www', '/public'))).toMatch(/^HTTP\/1\.1 101/)
  })

  it('keeps a site-scoped route off other hosts', () => {
    server.route('/admin', () => {}, {}, 'api')
    expect(response(upgrade({}, 'www', '/admin'))).toMatch(/^HTTP\/1\.1 404/)
    expect(response(upgrade({}, 'api', '/admin'))).toMatch(/^HTTP\/1\.1 101/)
  })
})
