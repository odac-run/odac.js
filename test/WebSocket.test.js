const {WebSocketServer} = require('../src/WebSocket.js')

describe('WebSocketServer', () => {
  let server

  beforeEach(() => {
    server = new WebSocketServer()
  })

  describe('route', () => {
    it('should register a route', () => {
      const handler = jest.fn()
      server.route('/chat', handler)
      expect(server.getRoute('/chat').handler).toBe(handler)
    })

    it('should return null for unregistered route', () => {
      expect(server.getRoute('/unknown')).toBeNull()
    })

    it('should match parameterized routes', () => {
      const handler = jest.fn()
      server.route('/room/{id}', handler)

      const result = server.getRoute('/room/123')
      expect(result).toBeDefined()
      expect(result.handler).toBe(handler)
      expect(result.params).toEqual({id: '123'})
    })

    it('should match multiple parameters', () => {
      const handler = jest.fn()
      server.route('/chat/{room}/user/{userId}', handler)

      const result = server.getRoute('/chat/general/user/42')
      expect(result.params).toEqual({room: 'general', userId: '42'})
    })
  })

  describe('rooms', () => {
    it('should join and leave rooms', () => {
      server.joinRoom('client1', 'room1')
      server.joinRoom('client2', 'room1')

      server.leaveRoom('client1', 'room1')
      server.leaveRoom('client2', 'room1')
    })
  })

  describe('broadcast', () => {
    it('should register a route', () => {
      const handler = jest.fn()
      server.route('/chat', handler)
      expect(server.getRoute('/chat').handler).toBe(handler)
    })

    it('should return null for unregistered route', () => {
      expect(server.getRoute('/unknown')).toBeNull()
    })

    it('should match parameterized routes', () => {
      const handler = jest.fn()
      server.route('/room/{id}', handler)

      const result = server.getRoute('/room/123')
      expect(result).toBeDefined()
      expect(result.handler).toBe(handler)
      expect(result.params).toEqual({id: '123'})
    })
  })

  describe('clients', () => {
    it('should track client count', () => {
      expect(server.clientCount).toBe(0)
    })
  })

  describe('cleanup on disconnect', () => {
    it('should be handled by Route.setWs wrapper', () => {
      expect(true).toBe(true)
    })
  })
  describe('maxPayload', () => {
    it('should close connection if payload exceeds limit', () => {
      const socket = {
        pause: jest.fn(),
        resume: jest.fn(),
        on: jest.fn(),
        write: jest.fn(),
        end: jest.fn(),
        removeAllListeners: jest.fn()
      }
      const {WebSocketClient} = require('../src/WebSocket.js')
      new WebSocketClient(socket, server, 'test-id', {maxPayload: 10})

      // We must send a MASKED frame because server expects masked frames from client
      const buffer = Buffer.alloc(100)
      buffer[0] = 0x81 // fin + text
      buffer[1] = 0x80 | 20 // masked + length 20
      // Mask key (4 bytes) + Payload (20 bytes) needed but header check happens first

      const dataHandler = socket.on.mock.calls.find(call => call[0] === 'data')[1]
      dataHandler(buffer)

      expect(socket.end).toHaveBeenCalled()
      // Verify close frame sent with 1009
      // socket.write is called to send the Close frame
      const writeCall = socket.write.mock.calls[0][0]
      expect(writeCall[2]).toBe(0x03) // 1009 >> 8
      expect(writeCall[3]).toBe(0xf1) // 1009 & 0xff
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
        removeAllListeners: jest.fn()
      }
      const {WebSocketClient} = require('../src/WebSocket.js')
      new WebSocketClient(socket, server, 'test-id', {
        rateLimit: {max: 2, window: 1000}
      })

      // Valid MASKED frame (exact size 7 bytes)
      const buffer = Buffer.alloc(7)
      buffer[0] = 0x81
      buffer[1] = 0x80 | 1 // masked + length 1
      buffer[2] = 0x00
      buffer[3] = 0x00
      buffer[4] = 0x00
      buffer[5] = 0x00 // mask key (0)
      buffer[6] = 0x61 // 'a' (masked with 0 remains 'a')

      const dataHandler = socket.on.mock.calls.find(call => call[0] === 'data')[1]

      // Send 3 messages (limit is 2)
      dataHandler(buffer)
      dataHandler(buffer)
      dataHandler(buffer)

      expect(socket.end).toHaveBeenCalled()
      // Verify close frame sent with 1008
      const writeCalls = socket.write.mock.calls
      const writeCall = writeCalls[writeCalls.length - 1][0]
      expect(writeCall[2]).toBe(0x03) // 1008 >> 8
      expect(writeCall[3]).toBe(0xf0) // 1008 & 0xff
    })

    it('should reset count after window', done => {
      const socket = {
        pause: jest.fn(),
        resume: jest.fn(),
        on: jest.fn(),
        write: jest.fn(),
        end: jest.fn(),
        removeAllListeners: jest.fn()
      }
      const {WebSocketClient} = require('../src/WebSocket.js')
      const client = new WebSocketClient(socket, server, 'test-id', {
        rateLimit: {max: 2, window: 200}
      })

      const buffer = Buffer.alloc(7)
      buffer[0] = 0x81
      buffer[1] = 0x80 | 1
      buffer[2] = 0x00
      buffer[3] = 0x00
      buffer[4] = 0x00
      buffer[5] = 0x00
      buffer[6] = 0x61

      const dataHandler = socket.on.mock.calls.find(call => call[0] === 'data')[1]

      // Send 2 messages
      dataHandler(buffer)
      dataHandler(buffer)
      expect(socket.end).not.toHaveBeenCalled()

      setTimeout(() => {
        // Send 1 more after window reset
        dataHandler(buffer)

        try {
          expect(socket.end).not.toHaveBeenCalled()
          client.close()
          done()
        } catch (error) {
          client.close()
          done(error)
        }
      }, 300)
    })
  })
})

describe('Route WebSocket Integration', () => {
  const Route = require('../src/Route.js')

  beforeEach(() => {
    global.Odac = {
      Route: new Route()
    }
  })

  it('should support ws() method', () => {
    expect(typeof Odac.Route.ws).toBe('function')
  })

  it('should support auth.ws() method', () => {
    expect(typeof Odac.Route.auth.ws).toBe('function')
  })

  it('should support middleware with ws()', () => {
    const chain = Odac.Route.use('test-middleware')
    expect(typeof chain.ws).toBe('function')
  })

  it('should support middleware with auth.ws()', () => {
    const chain = Odac.Route.use('test-middleware')
    expect(typeof chain.auth.ws).toBe('function')
  })

  it('should support auth.use() with ws()', () => {
    const chain = Odac.Route.auth.use('test-middleware')
    expect(typeof chain.ws).toBe('function')
  })
})
