const {WebSocketServer, WebSocketClient} = require('../../../src/WebSocket.js')

/**
 * Builds a masked WebSocket frame from raw payload bytes.
 * Uses a zero mask key for deterministic test output.
 */
function buildFrame(opcode, payload, fin = true) {
  const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload)
  const maskKey = Buffer.alloc(4) // zero mask — XOR is identity
  const masked = Buffer.from(buf)

  const finBit = fin ? 0x80 : 0x00
  const header = Buffer.alloc(2 + 4 + buf.length)
  header[0] = finBit | opcode
  header[1] = 0x80 | buf.length // masked bit + length
  maskKey.copy(header, 2)
  masked.copy(header, 6)

  return header
}

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

describe('WebSocketClient Fragmentation', () => {
  let server

  beforeEach(() => {
    server = new WebSocketServer()
  })

  it('should reassemble fragmented text messages', () => {
    const socket = createMockSocket()
    const client = new WebSocketClient(socket, server, 'frag-1')
    client.resume()

    const messages = []
    client.on('message', msg => messages.push(msg))

    const dataHandler = socket.on.mock.calls.find(c => c[0] === 'data')[1]

    // Fragment 1: TEXT opcode, fin=false
    dataHandler(buildFrame(0x1, 'hel', false))
    // Fragment 2: CONTINUATION opcode, fin=false
    dataHandler(buildFrame(0x0, 'lo ', false))
    // Fragment 3: CONTINUATION opcode, fin=true
    dataHandler(buildFrame(0x0, 'world', true))

    expect(messages).toEqual(['hello world'])
  })

  it('should reassemble fragmented binary messages', () => {
    const socket = createMockSocket()
    const client = new WebSocketClient(socket, server, 'frag-2')
    client.resume()

    const messages = []
    client.on('message', msg => messages.push(msg))

    const dataHandler = socket.on.mock.calls.find(c => c[0] === 'data')[1]

    const part1 = Buffer.from([0x01, 0x02])
    const part2 = Buffer.from([0x03, 0x04])

    // Fragment 1: BINARY opcode, fin=false
    dataHandler(buildFrame(0x2, part1, false))
    // Fragment 2: CONTINUATION opcode, fin=true
    dataHandler(buildFrame(0x0, part2, true))

    expect(messages.length).toBe(1)
    expect(Buffer.isBuffer(messages[0])).toBe(true)
    expect(messages[0]).toEqual(Buffer.from([0x01, 0x02, 0x03, 0x04]))
  })

  it('should close with 1002 on unexpected continuation frame', () => {
    const socket = createMockSocket()
    const client = new WebSocketClient(socket, server, 'frag-3')
    client.resume()

    const dataHandler = socket.on.mock.calls.find(c => c[0] === 'data')[1]

    // Send CONTINUATION without a preceding TEXT/BINARY
    dataHandler(buildFrame(0x0, 'orphan', true))

    expect(socket.end).toHaveBeenCalled()
  })

  it('should handle single unfragmented message normally', () => {
    const socket = createMockSocket()
    const client = new WebSocketClient(socket, server, 'frag-4')
    client.resume()

    const messages = []
    client.on('message', msg => messages.push(msg))

    const dataHandler = socket.on.mock.calls.find(c => c[0] === 'data')[1]

    // Single complete frame: TEXT, fin=true
    dataHandler(buildFrame(0x1, 'complete', true))

    expect(messages).toEqual(['complete'])
  })

  it('should discard fragment buffer on close', () => {
    const socket = createMockSocket()
    const client = new WebSocketClient(socket, server, 'frag-5')
    client.resume()

    const messages = []
    client.on('message', msg => messages.push(msg))

    const dataHandler = socket.on.mock.calls.find(c => c[0] === 'data')[1]

    // Start a fragmented message but close before completion
    dataHandler(buildFrame(0x1, 'partial', false))
    client.close()

    // No message should have been emitted
    expect(messages).toEqual([])
  })
})
