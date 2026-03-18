const Odac = require('../../src/Odac')

describe('Odac.image()', () => {
  let mockOdac

  beforeEach(() => {
    mockOdac = {
      Config: {request: {timeout: 1000}},
      DB: {init: jest.fn(), close: jest.fn()},
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
    delete global.Odac
    delete global.__dir
  })

  test('should be available on instance without req/res (cron context)', () => {
    const ctx = Odac.instance(null, 'cron')
    expect(typeof ctx.image).toBe('function')
  })

  test('should be available on instance with req/res (controller context)', () => {
    const mockReq = {
      method: 'GET',
      url: '/',
      headers: {host: 'www.example.com'},
      connection: {remoteAddress: '127.0.0.1'},
      on: jest.fn()
    }
    const mockRes = {on: jest.fn()}
    const ctx = Odac.instance('id', mockReq, mockRes)
    expect(typeof ctx.image).toBe('function')
  })

  test('should return a promise', () => {
    const ctx = Odac.instance(null, 'cron')
    const result = ctx.image('/images/test.jpg', {width: 300})
    expect(result).toBeInstanceOf(Promise)
  })

  test('should return original src when sharp is unavailable', async () => {
    const ctx = Odac.instance(null, 'cron')
    const result = await ctx.image('/images/test.jpg')
    // sharp not installed in test env → returns original src
    expect(result).toBe('/images/test.jpg')
  })

  test('should return empty string for empty src', async () => {
    const ctx = Odac.instance(null, 'cron')
    expect(await ctx.image('')).toBe('')
  })
})
