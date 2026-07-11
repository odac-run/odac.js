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
