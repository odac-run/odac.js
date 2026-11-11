const {PassThrough} = require('stream')
const OdacRequest = require('../../src/Request')

// The constructor runs for every HTTP request and every WebSocket upgrade.
// HTTP/1.0 does not require a Host header, so it must cope with one missing.

function makeReq(headers, connection = {remoteAddress: '::ffff:127.0.0.1'}) {
  const req = new PassThrough()
  req.method = 'GET'
  req.url = '/ws'
  req.headers = headers
  req.connection = connection
  return req
}

describe('Request.constructor()', () => {
  beforeEach(() => {
    global.Odac = {
      Config: {request: {timeout: 5000, maxBodySize: 1e6}},
      Route: {routes: {www: {}, api: {}}},
      Request: {}
    }
  })

  afterEach(() => {
    delete global.Odac
  })

  it('does not throw when the Host header is missing', () => {
    let request
    expect(() => (request = new OdacRequest('id', makeReq({}), null, {}))).not.toThrow()
    expect(request.host).toBe('')
    expect(request.route).toBe('www')
  })

  it('does not throw when the socket has no remote address', () => {
    let request
    expect(() => (request = new OdacRequest('id', makeReq({host: 'example.com'}, {}), null, {}))).not.toThrow()
    expect(request.ip).toBe('')
  })

  it('selects the route from the Host subdomain', () => {
    const request = new OdacRequest('id', makeReq({host: 'api.example.com'}), null, {})
    expect(request.route).toBe('api')
    expect(request.host).toBe('api.example.com')
  })
})
