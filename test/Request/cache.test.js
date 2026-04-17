const OdacRequest = require('../../src/Request')

describe('Request.cache()', () => {
  let req, res, request

  beforeEach(() => {
    global.Odac = {
      Config: {request: {timeout: 5000}},
      Route: {routes: {www: {}}},
      Storage: {get: jest.fn(), put: jest.fn()}
    }
    global.__dir = '/mock'

    req = {
      method: 'GET',
      url: '/test',
      headers: {host: 'www.example.com'},
      connection: {remoteAddress: '127.0.0.1'},
      on: jest.fn()
    }
    res = {
      writeHead: jest.fn(),
      end: jest.fn(),
      finished: false
    }
    request = new OdacRequest('test-id', req, res, {
      setTimeout: (fn, ms) => setTimeout(fn, ms)
    })
  })

  afterEach(() => {
    delete global.Odac
    delete global.__dir
  })

  it('should set X-ODAC-Cache header with the given TTL', () => {
    request.cache(3600)

    // Verify headers by printing them
    request.print()
    const headers = res.writeHead.mock.calls[0][1]
    expect(headers['X-ODAC-Cache']).toBe(3600)
  })

  it('should set Cache-Control to public with correct max-age', () => {
    request.cache(7200)

    request.print()
    const headers = res.writeHead.mock.calls[0][1]
    expect(headers['Cache-Control']).toBe('public, max-age=7200')
  })

  it('should override a previously set Cache-Control header', () => {
    request.header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
    request.cache(1800)

    request.print()
    const headers = res.writeHead.mock.calls[0][1]
    expect(headers['Cache-Control']).toBe('public, max-age=1800')
    expect(headers['X-ODAC-Cache']).toBe(1800)
  })

  it('should throw TypeError for non-integer values', () => {
    expect(() => request.cache(3.5)).toThrow(TypeError)
    expect(() => request.cache('3600')).toThrow(TypeError)
    expect(() => request.cache(null)).toThrow(TypeError)
    expect(() => request.cache(undefined)).toThrow(TypeError)
    expect(() => request.cache(NaN)).toThrow(TypeError)
    expect(() => request.cache(Infinity)).toThrow(TypeError)
  })

  it('should throw TypeError for zero or negative values', () => {
    expect(() => request.cache(0)).toThrow(TypeError)
    expect(() => request.cache(-1)).toThrow(TypeError)
    expect(() => request.cache(-3600)).toThrow(TypeError)
  })

  it('should work with small TTL values', () => {
    request.cache(1)

    request.print()
    const headers = res.writeHead.mock.calls[0][1]
    expect(headers['X-ODAC-Cache']).toBe(1)
    expect(headers['Cache-Control']).toBe('public, max-age=1')
  })

  it('should work with large TTL values', () => {
    request.cache(86400)

    request.print()
    const headers = res.writeHead.mock.calls[0][1]
    expect(headers['X-ODAC-Cache']).toBe(86400)
    expect(headers['Cache-Control']).toBe('public, max-age=86400')
  })
})
