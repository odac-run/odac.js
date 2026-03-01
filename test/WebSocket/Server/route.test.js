const {WebSocketServer} = require('../../../src/WebSocket.js')

describe('WebSocketServer Route Management', () => {
  let server

  beforeEach(() => {
    server = new WebSocketServer()
  })

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
