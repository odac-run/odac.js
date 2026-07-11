const {WebSocketServer, WebSocketClient} = require('../../../src/WebSocket.js')

function createMockSocket() {
  return {
    pause: jest.fn(),
    resume: jest.fn(),
    on: jest.fn(),
    write: jest.fn(),
    end: jest.fn(),
    removeAllListeners: jest.fn(),
    writable: true
  }
}

/**
 * Splits the frame handed to socket.write() back into opcode and payload.
 * Server-sent frames are never masked, so the payload starts right after
 * the (possibly extended) length field.
 */
function readFrame(socket) {
  const frame = socket.write.mock.calls[0][0]
  const opcode = frame[0] & 0x0f
  const length = frame[1] & 0x7f

  let offset = 2
  if (length === 126) offset = 4
  else if (length === 127) offset = 10

  return {opcode, payload: frame.subarray(offset)}
}

const openClients = []

/**
 * Creates a client and registers it for teardown.
 *
 * The constructor starts a rate-limit interval that is only cleared on close(),
 * so a client left open keeps Jest's event loop alive after the run finishes.
 */
function createClient(...args) {
  const client = new WebSocketClient(...args)
  openClients.push(client)
  return client
}

afterEach(() => {
  for (const client of openClients) client.close()
  openClients.length = 0
})

describe('WebSocketClient send', () => {
  let server
  let client
  let socket

  beforeEach(() => {
    server = new WebSocketServer()
    socket = createMockSocket()
    client = createClient(socket, server, 'send-1')
    client.resume()
  })

  it('should send strings as TEXT frames', () => {
    client.send('hello')

    const {opcode, payload} = readFrame(socket)

    expect(opcode).toBe(0x1)
    expect(payload.toString('utf8')).toBe('hello')
  })

  it('should send plain objects as JSON TEXT frames', () => {
    client.send({type: 'ping', n: 1})

    const {opcode, payload} = readFrame(socket)

    expect(opcode).toBe(0x1)
    expect(JSON.parse(payload.toString('utf8'))).toEqual({type: 'ping', n: 1})
  })

  it('should send a Buffer as a BINARY frame instead of JSON', () => {
    client.send(Buffer.from([0xde, 0xad, 0xbe, 0xef]))

    const {opcode, payload} = readFrame(socket)

    expect(opcode).toBe(0x2)
    expect([...payload]).toEqual([0xde, 0xad, 0xbe, 0xef])
  })

  it('should send a TypedArray as a BINARY frame', () => {
    client.send(new Uint8Array([1, 2, 3]))

    const {opcode, payload} = readFrame(socket)

    expect(opcode).toBe(0x2)
    expect([...payload]).toEqual([1, 2, 3])
  })

  it('should send an ArrayBuffer as a BINARY frame', () => {
    const view = new Uint8Array([9, 8, 7])
    client.send(view.buffer)

    const {opcode, payload} = readFrame(socket)

    expect(opcode).toBe(0x2)
    expect([...payload]).toEqual([9, 8, 7])
  })

  it('should preserve the bytes of multi-byte TypedArrays', () => {
    // Buffer.from(view) would read each element as a number and truncate it
    // to one byte, silently corrupting anything wider than a Uint8Array.
    client.send(new Uint16Array([0x0100, 0x0200]))

    const {opcode, payload} = readFrame(socket)

    expect(opcode).toBe(0x2)
    expect(payload.length).toBe(4)
    expect([...payload]).toEqual([0x00, 0x01, 0x00, 0x02])
  })

  it('should honour the byteOffset of a view over a larger buffer', () => {
    const backing = new Uint8Array([1, 2, 3, 4, 5, 6])
    const view = backing.subarray(2, 5)

    client.send(view)

    const {payload} = readFrame(socket)

    expect([...payload]).toEqual([3, 4, 5])
  })

  it('should send binary through sendBinary without corrupting wide views', () => {
    client.sendBinary(new Uint16Array([0x0100]))

    const {opcode, payload} = readFrame(socket)

    expect(opcode).toBe(0x2)
    expect([...payload]).toEqual([0x00, 0x01])
  })

  it('should not send when the connection is not open', () => {
    const closed = createClient(createMockSocket(), server, 'send-2')

    closed.send('hello')

    expect(closed.readyState).toBe(WebSocketClient.CONNECTING)
  })
})
