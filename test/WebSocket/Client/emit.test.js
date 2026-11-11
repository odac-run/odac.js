const {EventEmitter} = require('events')
const {WebSocketServer, WebSocketClient} = require('../../../src/WebSocket.js')

/** Builds a masked text frame with a zero mask key (XOR is identity). */
function textFrame(text) {
  const payload = Buffer.from(text)
  const frame = Buffer.alloc(6 + payload.length)
  frame[0] = 0x81
  frame[1] = 0x80 | payload.length
  payload.copy(frame, 6)
  return frame
}

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

/**
 * #emit runs user handlers inside the socket 'data' listener. A throw or a
 * rejected promise there must not escape as an uncaught exception or an
 * unhandled rejection, both of which terminate the worker.
 */
describe('WebSocketClient.#emit()', () => {
  let server
  let socket
  let client

  beforeEach(() => {
    jest.spyOn(console, 'error').mockImplementation(() => {})
    server = new WebSocketServer()
    socket = createSocket()
    client = new WebSocketClient(socket, server, 'c1')
    client.resume()
  })

  afterEach(() => {
    client.close()
    jest.restoreAllMocks()
  })

  it('contains a synchronous throw from a message handler', () => {
    client.on('message', () => {
      throw new Error('handler bug')
    })

    expect(() => socket.emit('data', textFrame('hi'))).not.toThrow()
    expect(console.error).toHaveBeenCalled()
  })

  it('still runs the remaining handlers after one throws', () => {
    const second = jest.fn()
    client.on('message', () => {
      throw new Error('handler bug')
    })
    client.on('message', second)

    socket.emit('data', textFrame('hi'))

    expect(second).toHaveBeenCalledWith('hi')
  })

  it('contains a rejection from an async message handler', async () => {
    const onUnhandled = jest.fn()
    process.on('unhandledRejection', onUnhandled)
    client.on('message', async () => {
      throw new Error('async handler bug')
    })

    socket.emit('data', textFrame('hi'))
    await new Promise(resolve => setImmediate(resolve))
    process.removeListener('unhandledRejection', onUnhandled)

    expect(onUnhandled).not.toHaveBeenCalled()
    expect(console.error).toHaveBeenCalled()
  })

  it('keeps the connection open after a handler error', () => {
    client.on('message', () => {
      throw new Error('handler bug')
    })

    socket.emit('data', textFrame('hi'))

    expect(client.readyState).toBe(WebSocketClient.OPEN)
  })
})
