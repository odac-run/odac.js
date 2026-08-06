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

describe('WebSocketClient #handleMessage', () => {
  let server

  beforeEach(() => {
    server = new WebSocketServer()
  })

  /** Wires up a client and returns the collected messages plus the frame pump. */
  function setup(options = {}) {
    const socket = createMockSocket()
    const client = createClient(socket, server, 'msg-1', options)
    client.resume()

    const messages = []
    client.on('message', msg => messages.push(msg))

    const dataHandler = socket.on.mock.calls.find(c => c[0] === 'data')[1]
    return {messages, send: frame => dataHandler(frame)}
  }

  describe('binary frames', () => {
    // JSON.parse(Buffer) stringifies its argument first, so a binary payload
    // that happens to spell a JSON literal used to arrive as that literal.
    it('should preserve a binary payload that looks like a JSON number', () => {
      const {messages, send} = setup()

      send(buildFrame(0x2, Buffer.from('42')))

      expect(Buffer.isBuffer(messages[0])).toBe(true)
      expect(messages[0]).toEqual(Buffer.from('42'))
    })

    it('should preserve a binary payload that looks like a JSON object', () => {
      const {messages, send} = setup()

      send(buildFrame(0x2, Buffer.from('{"a":1}')))

      expect(Buffer.isBuffer(messages[0])).toBe(true)
      expect(messages[0]).toEqual(Buffer.from('{"a":1}'))
    })

    it('should preserve a reassembled binary payload that looks like JSON', () => {
      const {messages, send} = setup()

      send(buildFrame(0x2, Buffer.from('4'), false))
      send(buildFrame(0x0, Buffer.from('2'), true))

      expect(Buffer.isBuffer(messages[0])).toBe(true)
      expect(messages[0]).toEqual(Buffer.from('42'))
    })
  })

  describe('text frames', () => {
    it('should parse JSON payloads by default', () => {
      const {messages, send} = setup()

      send(buildFrame(0x1, '{"a":1}'))

      expect(messages[0]).toEqual({a: 1})
    })

    it('should pass non-JSON payloads through untouched', () => {
      const {messages, send} = setup()

      send(buildFrame(0x1, 'ls'))

      expect(messages[0]).toBe('ls')
    })
  })

  describe('parseJson: false', () => {
    // A payload of "1" must stay the string "1" rather than becoming the number 1.
    it('should keep numeric text payloads as strings', () => {
      const {messages, send} = setup({parseJson: false})

      send(buildFrame(0x1, '1'))
      send(buildFrame(0x1, '42'))
      send(buildFrame(0x1, '1\r\n'))

      expect(messages).toEqual(['1', '42', '1\r\n'])
    })

    it('should keep JSON object payloads as strings', () => {
      const {messages, send} = setup({parseJson: false})

      send(buildFrame(0x1, '{"a":1}'))

      expect(messages[0]).toBe('{"a":1}')
    })

    it('should still deliver binary payloads as buffers', () => {
      const {messages, send} = setup({parseJson: false})

      send(buildFrame(0x2, Buffer.from([0x01, 0x02])))

      expect(Buffer.isBuffer(messages[0])).toBe(true)
      expect(messages[0]).toEqual(Buffer.from([0x01, 0x02]))
    })
  })
})
