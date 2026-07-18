const {WebSocketServer, WebSocketClient} = require('../../../src/WebSocket.js')

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

describe('WebSocketClient Limits', () => {
  let server

  beforeEach(() => {
    server = new WebSocketServer()
  })

  describe('maxPayload', () => {
    it('should close connection if payload exceeds limit', () => {
      const socket = {
        pause: jest.fn(),
        resume: jest.fn(),
        on: jest.fn(),
        write: jest.fn(),
        end: jest.fn(),
        removeAllListeners: jest.fn(),
        writable: true
      }
      const client = createClient(socket, server, 'test-id', {maxPayload: 10})
      client.resume()

      const buffer = Buffer.alloc(100)
      buffer[0] = 0x81
      buffer[1] = 0x80 | 20
      const dataHandler = socket.on.mock.calls.find(call => call[0] === 'data')[1]
      dataHandler(buffer)

      expect(socket.end).toHaveBeenCalled()
    })
  })

  describe('fragmented message total size', () => {
    // A single unmasked frame with all-zero mask keys, so masked payload == payload.
    function fragment(opcode, fin, payload) {
      const b = Buffer.alloc(6 + payload.length)
      b[0] = (fin ? 0x80 : 0x00) | opcode
      b[1] = 0x80 | payload.length // MASK bit + length (<126)
      // mask key bytes 2..5 left as 0 → payload copied verbatim
      payload.copy(b, 6)
      return b
    }

    it('closes 1009 when combined fragments exceed maxPayload', () => {
      const socket = {
        pause: jest.fn(),
        resume: jest.fn(),
        on: jest.fn(),
        write: jest.fn(),
        end: jest.fn(),
        removeAllListeners: jest.fn(),
        writable: true
      }
      const client = createClient(socket, server, 'test-id', {maxPayload: 10})
      client.resume()
      const dataHandler = socket.on.mock.calls.find(call => call[0] === 'data')[1]

      // Each frame (6 bytes) is under maxPayload, but the running total is not.
      dataHandler(fragment(0x1, false, Buffer.alloc(6))) // first text fragment
      expect(socket.end).not.toHaveBeenCalled()
      dataHandler(fragment(0x0, false, Buffer.alloc(6))) // continuation → total 12 > 10
      expect(socket.end).toHaveBeenCalled()
    })
  })

  describe('rateLimit', () => {
    it('should close connection if rate limit exceeded', () => {
      const socket = {
        pause: jest.fn(),
        resume: jest.fn(),
        on: jest.fn(),
        write: jest.fn(),
        end: jest.fn(),
        removeAllListeners: jest.fn(),
        writable: true
      }
      const client = createClient(socket, server, 'test-id', {rateLimit: {max: 2, window: 1000}})
      client.resume()

      const buffer = Buffer.alloc(7)
      buffer[0] = 0x81
      buffer[1] = 0x80 | 1
      buffer[2] = buffer[3] = buffer[4] = buffer[5] = 0
      buffer[6] = 0x61

      const dataHandler = socket.on.mock.calls.find(call => call[0] === 'data')[1]
      dataHandler(buffer)
      dataHandler(buffer)
      dataHandler(buffer)
      expect(socket.end).toHaveBeenCalled()
    })
  })
})
