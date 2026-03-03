const {WebSocketServer} = require('../../../src/WebSocket.js')

describe('WebSocketServer Broadcast', () => {
  let server

  beforeEach(() => {
    server = new WebSocketServer()
  })

  it('should send message to all connected clients', () => {
    const client1 = {id: 'c1', send: jest.fn()}
    const client2 = {id: 'c2', send: jest.fn()}

    server.clients.set('c1', client1)
    server.clients.set('c2', client2)

    server.broadcast('hello')
    expect(client1.send).toHaveBeenCalledWith('hello')
    expect(client2.send).toHaveBeenCalledWith('hello')
  })

  it('should exclude specified client from broadcast', () => {
    const client1 = {id: 'c1', send: jest.fn()}
    const client2 = {id: 'c2', send: jest.fn()}

    server.clients.set('c1', client1)
    server.clients.set('c2', client2)

    server.broadcast('hello', 'c1')
    expect(client1.send).not.toHaveBeenCalled()
    expect(client2.send).toHaveBeenCalledWith('hello')
  })
})
