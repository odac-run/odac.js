const {WebSocketServer, WebSocketClient, READY_STATE} = require('../../../src/WebSocket.js')

/**
 * Helper: creates a mock TCP socket with the minimum interface
 * required by WebSocketClient.
 */
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

describe('WebSocketClient readyState', () => {
  let server

  beforeEach(() => {
    server = new WebSocketServer()
  })

  it('should expose static state constants matching READY_STATE enum', () => {
    expect(WebSocketClient.CONNECTING).toBe(0)
    expect(WebSocketClient.OPEN).toBe(1)
    expect(WebSocketClient.CLOSING).toBe(2)
    expect(WebSocketClient.CLOSED).toBe(3)
  })

  it('should export READY_STATE enum', () => {
    expect(READY_STATE).toEqual({
      CONNECTING: 0,
      OPEN: 1,
      CLOSING: 2,
      CLOSED: 3
    })
  })

  it('should start in CONNECTING state', () => {
    const socket = createMockSocket()
    const client = new WebSocketClient(socket, server, 'rs-1')
    expect(client.readyState).toBe(READY_STATE.CONNECTING)
  })

  it('should transition to OPEN on resume()', () => {
    const socket = createMockSocket()
    const client = new WebSocketClient(socket, server, 'rs-2')

    client.resume()

    expect(client.readyState).toBe(READY_STATE.OPEN)
    expect(socket.resume).toHaveBeenCalled()
  })

  it('should transition to CLOSED after close()', () => {
    const socket = createMockSocket()
    const client = new WebSocketClient(socket, server, 'rs-3')
    client.resume()

    client.close()

    expect(client.readyState).toBe(READY_STATE.CLOSED)
    expect(socket.end).toHaveBeenCalled()
  })

  it('should be idempotent — second close() is a no-op', () => {
    const socket = createMockSocket()
    const client = new WebSocketClient(socket, server, 'rs-4')
    client.resume()

    client.close()
    client.close()

    expect(socket.end).toHaveBeenCalledTimes(1)
  })

  it('should not send data when in CONNECTING state', () => {
    const socket = createMockSocket()
    const client = new WebSocketClient(socket, server, 'rs-5')

    client.send('hello')

    expect(socket.write).not.toHaveBeenCalled()
  })

  it('should not send data when in CLOSED state', () => {
    const socket = createMockSocket()
    const client = new WebSocketClient(socket, server, 'rs-6')
    client.resume()
    client.close()

    client.send('hello')

    // Only the close frame write should exist, no data frame
    const writes = socket.write.mock.calls
    const lastWrite = writes[writes.length - 1]
    // Close frame starts with 0x88
    expect(lastWrite[0][0]).toBe(0x88)
  })

  it('should not send ping when not OPEN', () => {
    const socket = createMockSocket()
    const client = new WebSocketClient(socket, server, 'rs-7')

    client.ping()

    expect(socket.write).not.toHaveBeenCalled()
  })

  it('should not write when socket is not writable', () => {
    const socket = createMockSocket()
    socket.writable = false
    const client = new WebSocketClient(socket, server, 'rs-8')
    client.resume()

    client.send('hello')

    expect(socket.write).not.toHaveBeenCalled()
  })

  it('should transition to CLOSED when socket fires close event', () => {
    const socket = createMockSocket()
    const client = new WebSocketClient(socket, server, 'rs-9')
    server.clients.set('rs-9', client)
    client.resume()

    // Simulate socket 'close' event
    const closeHandler = socket.on.mock.calls.find(c => c[0] === 'close')[1]
    closeHandler()

    expect(client.readyState).toBe(READY_STATE.CLOSED)
  })

  it('should emit close event only once on double cleanup', () => {
    const socket = createMockSocket()
    const client = new WebSocketClient(socket, server, 'rs-10')
    server.clients.set('rs-10', client)
    client.resume()

    const closeSpy = jest.fn()
    client.on('close', closeSpy)

    client.close()

    // Simulate socket 'close' event firing after close() already cleaned up
    const closeHandler = socket.on.mock.calls.find(c => c[0] === 'close')
    if (closeHandler) closeHandler[1]()

    expect(closeSpy).toHaveBeenCalledTimes(1)
  })
})
