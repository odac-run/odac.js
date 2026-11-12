const {PassThrough} = require('stream')
const OdacRequest = require('../../src/Request')
const Config = require('../../src/Config')

// Default response headers come from Config.headers so an app reached without the ODAC proxy
// still sends them, and header() writes must replace a header whatever its casing.

function build(headers = {}) {
  const req = new PassThrough()
  req.method = 'GET'
  req.url = '/'
  req.headers = Object.assign({host: 'www.example.com'}, headers)
  req.connection = {remoteAddress: '127.0.0.1'}
  const res = {writeHead: jest.fn(), end: jest.fn(), finished: false, on: jest.fn()}
  const request = new OdacRequest('id', req, res, {setTimeout: () => null})
  return {request, res}
}

const sentHeaders = res => res.writeHead.mock.calls[0][1]

describe('Request.header()', () => {
  beforeEach(() => {
    global.Odac = {
      Config: {request: {timeout: 5000, maxBodySize: 1e6}, headers: {...Config.headers}},
      Route: {routes: {www: {}}},
      Request: {}
    }
  })

  afterEach(() => {
    delete global.Odac
  })

  it('reads request headers by any casing without scanning them', () => {
    const {request} = build({'x-requested-with': 'xhr', 'user-agent': 'UA'})
    let scans = 0
    request.req.headers = new Proxy(request.req.headers, {
      ownKeys: target => {
        scans++
        return Reflect.ownKeys(target)
      }
    })
    const results = [request.header('X-Requested-With'), request.header('user-agent'), request.header('X-Missing')]
    expect(results).toEqual(['xhr', 'UA', undefined])
    expect(scans).toBe(0)
  })

  it('sends the configured security headers and no Server banner', () => {
    const {request, res} = build()
    request.end('ok')
    expect(sentHeaders(res)).toMatchObject({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'SAMEORIGIN',
      'Referrer-Policy': 'strict-origin-when-cross-origin'
    })
    expect(sentHeaders(res).Server).toBeUndefined()
  })

  it('drops a default set to false or null in the config', () => {
    global.Odac.Config.headers['X-Frame-Options'] = false
    global.Odac.Config.headers['Referrer-Policy'] = null
    const {request, res} = build()
    request.end('ok')
    expect(sentHeaders(res)['X-Frame-Options']).toBeUndefined()
    expect(sentHeaders(res)['Referrer-Policy']).toBeUndefined()
    expect(sentHeaders(res)['X-Content-Type-Options']).toBe('nosniff')
  })

  it('replaces a header set with different casing instead of sending it twice', () => {
    const {request, res} = build()
    request.header('x-frame-options', 'DENY')
    request.end('ok')
    const names = Object.keys(sentHeaders(res)).filter(name => name.toLowerCase() === 'x-frame-options')
    expect(names).toEqual(['x-frame-options'])
    expect(sentHeaders(res)['x-frame-options']).toBe('DENY')
  })

  it('removes a header regardless of casing', () => {
    const {request, res} = build()
    request.header('x-content-type-options', null)
    request.end('ok')
    expect(sentHeaders(res)['X-Content-Type-Options']).toBeUndefined()
  })

  it('reads request headers case-insensitively', () => {
    const {request} = build({'x-custom': 'yes'})
    expect(request.header('X-Custom')).toBe('yes')
    expect(request.header('X-Missing')).toBeUndefined()
  })
})
