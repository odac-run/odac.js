const Odac = require('../../src/Odac')

describe('Odac.instance()', () => {
  let mockOdac
  let ctx

  beforeEach(() => {
    mockOdac = {
      Config: {request: {timeout: 1000}},
      DB: {init: jest.fn(), close: jest.fn()},
      Auth: {constructor: jest.fn()},
      Route: {
        init: jest.fn(),
        routes: {www: {}}
      },
      Storage: {get: jest.fn(), put: jest.fn()},
      Env: {get: jest.fn()}
    }
    global.Odac = mockOdac
    global.__dir = '/mock'
  })

  afterEach(() => {
    ctx?.Request.clearTimeout()
    ctx = null
    delete global.Odac
    delete global.__dir
  })

  it('routes __ and __x to Lang.get and Lang.getx', async () => {
    const mockReq = {method: 'GET', url: '/', headers: {host: 'www.example.com'}, connection: {remoteAddress: '127.0.0.1'}, on: jest.fn()}
    ctx = Odac.instance('id', mockReq, {on: jest.fn(), writeHead: jest.fn(), end: jest.fn()})
    ctx.Lang.get = jest.fn(async () => 'plain')
    ctx.Lang.getx = jest.fn(async () => 'contextual')

    expect(await ctx.__('Gül', 1)).toBe('plain')
    expect(await ctx.__x('Gül', 'verb', 1)).toBe('contextual')
    expect(ctx.Lang.get).toHaveBeenCalledWith('Gül', 1)
    expect(ctx.Lang.getx).toHaveBeenCalledWith('Gül', 'verb', 1)
  })

  it('should create a context object with req/res', () => {
    const mockReq = {
      method: 'GET',
      url: '/',
      headers: {host: 'www.example.com'},
      connection: {remoteAddress: '127.0.0.1'},
      on: jest.fn()
    }
    const mockRes = {on: jest.fn(), writeHead: jest.fn(), end: jest.fn()}

    ctx = Odac.instance('id', mockReq, mockRes)

    expect(ctx.Request).toBeDefined()
    expect(ctx.Request.id).toBe('id')
  })

  it('should provide helper methods on the context', () => {
    const mockReq = {
      method: 'GET',
      url: '/',
      headers: {host: 'www.example.com'},
      connection: {remoteAddress: '127.0.0.1'},
      on: jest.fn()
    }
    const mockRes = {on: jest.fn()}
    ctx = Odac.instance('id', mockReq, mockRes)

    expect(typeof ctx.abort).toBe('function')
    expect(typeof ctx.cookie).toBe('function')
    expect(typeof ctx.env).toBe('function')
  })
})
