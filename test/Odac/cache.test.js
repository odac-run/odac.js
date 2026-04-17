const Odac = require('../../src/Odac')

describe('Odac.cache()', () => {
  let mockOdac

  beforeEach(() => {
    mockOdac = {
      Config: {request: {timeout: 1000}},
      Route: {routes: {www: {}}},
      Storage: {get: jest.fn(), put: jest.fn()}
    }
    global.Odac = mockOdac
    global.__dir = '/mock'
  })

  afterEach(() => {
    delete global.Odac
    delete global.__dir
  })

  it('should expose cache() as a shorthand on the instance', () => {
    const mockReq = {
      method: 'GET',
      url: '/',
      headers: {host: 'www.example.com'},
      connection: {remoteAddress: '127.0.0.1'},
      on: jest.fn()
    }
    const mockRes = {on: jest.fn(), writeHead: jest.fn(), end: jest.fn()}

    const ctx = Odac.instance('id', mockReq, mockRes)

    expect(typeof ctx.cache).toBe('function')
  })

  it('should delegate to Request.cache()', () => {
    const mockReq = {
      method: 'GET',
      url: '/',
      headers: {host: 'www.example.com'},
      connection: {remoteAddress: '127.0.0.1'},
      on: jest.fn()
    }
    const mockRes = {on: jest.fn(), writeHead: jest.fn(), end: jest.fn(), finished: false}

    const ctx = Odac.instance('id', mockReq, mockRes)
    ctx.cache(3600)

    ctx.Request.print()
    const headers = mockRes.writeHead.mock.calls[0][1]
    expect(headers['X-ODAC-Cache']).toBe(3600)
    expect(headers['Cache-Control']).toBe('public, max-age=3600')
  })
})
