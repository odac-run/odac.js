const {EventEmitter} = require('events')
const {WebSocketServer, WebSocketClient} = require('../../../src/WebSocket.js')

/**
 * Frame-level protocol rules (RFC 6455 §5), chunked parsing, heartbeat and slow-client
 * backpressure.
 */

function frame(opcode, payload = Buffer.alloc(0), {fin = true, rsv = 0, mask = [1, 2, 3, 4]} = {}) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload)
  let header
  if (data.length < 126) {
    header = Buffer.from([(fin ? 0x80 : 0) | rsv | opcode, 0x80 | data.length])
  } else if (data.length < 65536) {
    header = Buffer.alloc(4)
    header[0] = (fin ? 0x80 : 0) | rsv | opcode
    header[1] = 0x80 | 126
    header.writeUInt16BE(data.length, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = (fin ? 0x80 : 0) | rsv | opcode
    header[1] = 0x80 | 127
    header.writeBigUInt64BE(BigInt(data.length), 2)
  }
  const key = Buffer.from(mask)
  const masked = Buffer.from(data)
  for (let i = 0; i < masked.length; i++) masked[i] ^= key[i % 4]
  return Buffer.concat([header, key, masked])
}

function createSocket() {
  const socket = new EventEmitter()
  socket.pause = jest.fn()
  socket.resume = jest.fn()
  socket.write = jest.fn()
  socket.end = jest.fn()
  socket.destroy = jest.fn()
  socket.writable = true
  socket.writableLength = 0
  return socket
}

const closeCode = socket => {
  const sent = socket.write.mock.calls.map(c => c[0]).find(f => (f[0] & 0x0f) === 0x8)
  return sent ? sent.readUInt16BE(2) : null
}

describe('WebSocketClient protocol handling', () => {
  let server
  let socket
  let client
  let messages

  beforeEach(() => {
    server = new WebSocketServer()
    socket = createSocket()
    client = new WebSocketClient(socket, server, 'c1', {rateLimit: {max: 0}})
    messages = []
    client.on('message', message => messages.push(message))
    client.resume()
  })

  afterEach(() => client.close())

  it('rejects frames with reserved bits set', () => {
    socket.emit('data', frame(0x1, 'x', {rsv: 0x40}))
    expect(closeCode(socket)).toBe(1002)
    expect(messages).toEqual([])
  })

  it('rejects unknown opcodes', () => {
    socket.emit('data', frame(0x3, 'x'))
    expect(closeCode(socket)).toBe(1002)
  })

  it('rejects fragmented or oversized control frames', () => {
    socket.emit('data', frame(0x9, 'p', {fin: false}))
    expect(closeCode(socket)).toBe(1002)

    const other = createSocket()
    const second = new WebSocketClient(other, server, 'c2')
    second.resume()
    other.emit('data', frame(0x9, Buffer.alloc(126)))
    expect(closeCode(other)).toBe(1002)
    second.close()
  })

  it('closes with 1007 on invalid UTF-8 in a text message', () => {
    socket.emit('data', frame(0x1, Buffer.from([0x68, 0xc3, 0x28])))
    expect(closeCode(socket)).toBe(1007)
    expect(messages).toEqual([])
  })

  it('rejects a new data frame inside a fragmented message', () => {
    socket.emit('data', frame(0x1, 'he', {fin: false}))
    socket.emit('data', frame(0x1, 'llo'))
    expect(closeCode(socket)).toBe(1002)
  })

  it('reassembles frames delivered one byte at a time', () => {
    const bytes = Buffer.concat([frame(0x1, '{"a":1}'), frame(0x2, Buffer.from([7, 8])), frame(0x1, 'ş')])
    for (const byte of bytes) socket.emit('data', Buffer.from([byte]))
    expect(messages).toEqual([{a: 1}, Buffer.from([7, 8]), 'ş'])
  })

  it('parses a large message from many chunks without re-copying the buffer', () => {
    const payload = Buffer.alloc(2 * 1024 * 1024, 0x61)
    const bytes = frame(0x2, payload)
    const concat = jest.spyOn(Buffer, 'concat')
    for (let i = 0; i < bytes.length; i += 16384) socket.emit('data', bytes.subarray(i, i + 16384))
    expect(messages).toHaveLength(1)
    expect(messages[0].equals(payload)).toBe(true)
    // One join for the frame (plus header merges), not one per chunk.
    expect(concat.mock.calls.length).toBeLessThan(5)
    concat.mockRestore()
  })

  it('does not start a timer per connection for the rate limit', () => {
    const setIntervalSpy = jest.spyOn(global, 'setInterval')
    const limited = new WebSocketClient(createSocket(), server, 'c3', {rateLimit: {max: 2, window: 1000}})
    expect(setIntervalSpy).not.toHaveBeenCalled()
    limited.close()
    setIntervalSpy.mockRestore()
  })

  it('still enforces the rate limit within a window', () => {
    const limitedSocket = createSocket()
    const limited = new WebSocketClient(limitedSocket, server, 'c4', {rateLimit: {max: 2, window: 60000}})
    limited.resume()
    for (let i = 0; i < 3; i++) limitedSocket.emit('data', frame(0x1, 'x'))
    expect(closeCode(limitedSocket)).toBe(1008)
  })
})

describe('WebSocketClient liveness and backpressure', () => {
  it('pings on a heartbeat and drops a peer that never answers', () => {
    const socket = createSocket()
    const client = new WebSocketClient(socket, new WebSocketServer(), 'c1')
    client.resume()

    client.heartbeat()
    const ping = socket.write.mock.calls.at(-1)[0]
    expect(ping[0] & 0x0f).toBe(0x9)
    expect(socket.destroy).not.toHaveBeenCalled()

    client.heartbeat()
    expect(socket.destroy).toHaveBeenCalled()
    expect(client.readyState).toBe(WebSocketClient.CLOSED)
  })

  it('keeps a peer that sends anything between heartbeats', () => {
    const socket = createSocket()
    const client = new WebSocketClient(socket, new WebSocketServer(), 'c1')
    client.resume()

    client.heartbeat()
    socket.emit('data', frame(0xa)) // pong
    client.heartbeat()
    expect(socket.destroy).not.toHaveBeenCalled()
    client.close()
  })

  it('drops a client whose unsent data exceeds maxBuffered', () => {
    jest.spyOn(console, 'error').mockImplementation(() => {})
    const socket = createSocket()
    const client = new WebSocketClient(socket, new WebSocketServer(), 'c1', {maxBuffered: 1024})
    client.resume()

    socket.writableLength = 512
    client.send('small')
    expect(socket.destroy).not.toHaveBeenCalled()

    socket.writableLength = 4096
    client.send('one more')
    expect(socket.destroy).toHaveBeenCalled()
    expect(client.readyState).toBe(WebSocketClient.CLOSED)
    console.error.mockRestore()
  })
})
