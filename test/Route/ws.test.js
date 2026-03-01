const Route = require('../../src/Route')

describe('Route WebSocket methods', () => {
  let route

  beforeEach(() => {
    route = new Route()
  })

  it('should call ws() method successfully', () => {
    const handler = jest.fn()
    expect(() => {
      route.ws('/test', handler, {token: false})
    }).not.toThrow()
  })

  it('should call authWs() method successfully', () => {
    const handler = jest.fn()
    expect(() => {
      route.authWs('/test', handler)
    }).not.toThrow()
  })
})
