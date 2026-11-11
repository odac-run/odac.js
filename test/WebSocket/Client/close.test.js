const {EventEmitter} = require('events')
const {WebSocketServer, WebSocketClient, READY_STATE} = require('../../../src/WebSocket.js')

/**
 * EventEmitter-backed socket: unlike a jest.fn() stub, emitting 'error' with no
 * listener throws here exactly as it does on a real net.Socket, which is the
 * crash this suite guards against.
 */
function createSocket() {
  const socket = new EventEmitter()
  socket.pause = jest.fn()
  socket.resume = jest.fn()
  socket.write = jest.fn()
  socket.end = jest.fn()
  socket.destroy = jest.fn(() => socket.emit('close'))
  socket.writable = true
  return socket
}

function resetError() {
  return Object.assign(new Error('read ECONNRESET'), {code: 'ECONNRESET', syscall: 'read'})
}

describe('WebSocketClient.close()', () => {
  let server

  beforeEach(() => {
    jest.useFakeTimers()
    server = new WebSocketServer()
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it('survives a peer reset that arrives after the server closed the connection', () => {
    const socket = createSocket()
    const client = new WebSocketClient(socket, server, 'c1')

    client.close(4002, 'Missing token')

    expect(() => socket.emit('error', resetError())).not.toThrow()
  })

  it('does not forward post-close socket errors to user error handlers', () => {
    const socket = createSocket()
    const client = new WebSocketClient(socket, server, 'c1')
    const onError = jest.fn()
    client.on('error', onError)

    client.close()
    socket.emit('error', resetError())

    expect(onError).not.toHaveBeenCalled()
  })

  it('stops parsing frames once closed', () => {
    const socket = createSocket()
    const client = new WebSocketClient(socket, server, 'c1')

    client.close()

    expect(socket.listenerCount('data')).toBe(0)
  })

  it('leaves listeners it does not own on the socket', () => {
    const socket = createSocket()
    const foreign = jest.fn()
    socket.on('end', foreign)
    const client = new WebSocketClient(socket, server, 'c1')

    client.close()

    expect(socket.listeners('end')).toContain(foreign)
  })

  it('destroys a socket the peer never finishes closing', () => {
    const socket = createSocket()
    const client = new WebSocketClient(socket, server, 'c1')

    client.close()
    expect(socket.end).toHaveBeenCalled()
    expect(socket.destroy).not.toHaveBeenCalled()

    jest.runOnlyPendingTimers()

    expect(socket.destroy).toHaveBeenCalled()
  })

  it('does not destroy a socket that closed within the grace period', () => {
    const socket = createSocket()
    const client = new WebSocketClient(socket, server, 'c1')

    client.close()
    socket.emit('close')
    jest.runOnlyPendingTimers()

    expect(socket.destroy).not.toHaveBeenCalled()
  })

  it('emits close once and reaches CLOSED', () => {
    const socket = createSocket()
    const client = new WebSocketClient(socket, server, 'c1')
    const onClose = jest.fn()
    client.on('close', onClose)

    client.close()
    socket.emit('close')

    expect(client.readyState).toBe(READY_STATE.CLOSED)
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
