const {WebSocketServer, WebSocketClient} = require('../../../src/WebSocket.js')

describe('WebSocketClient Limits', () => {
  let server

  beforeEach(() => {
    server = new WebSocketServer()
  })

  describe('maxPayload', () => {
    it('should close connection if payload exceeds limit', () => {
      const socket = {
        pause: jest.fn(),
        on: jest.fn(),
        write: jest.fn(),
        end: jest.fn(),
        removeAllListeners: jest.fn()
      }
      new WebSocketClient(socket, server, 'test-id', {maxPayload: 10})

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
        on: jest.fn(),
        write: jest.fn(),
        end: jest.fn(),
        removeAllListeners: jest.fn()
      }
      new WebSocketClient(socket, server, 'test-id', {rateLimit: {max: 2, window: 1000}})

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
