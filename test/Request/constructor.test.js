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
  describe('proxy connection headers', () => {
    const proxyHeaders = {host: 'example.com', 'x-odac-connection-remoteaddress': '1.2.3.4', 'x-odac-connection-ssl': 'true'}

    it('uses the client address and TLS state set by a local proxy', () => {
      const request = new OdacRequest('id', makeReq({...proxyHeaders}, {remoteAddress: '::ffff:127.0.0.1'}), null, {})
      expect(request.ip).toBe('1.2.3.4')
      expect(request.ssl).toBe(true)
    })

    it('uses the headers from a proxy on a container network', () => {
      const request = new OdacRequest('id', makeReq({...proxyHeaders}, {remoteAddress: '172.18.0.2'}), null, {})
      expect(request.ip).toBe('1.2.3.4')
    })

    it('ignores the headers when the peer is a public address', () => {
      const request = new OdacRequest('id', makeReq({...proxyHeaders}, {remoteAddress: '::ffff:198.51.100.7'}), null, {})
      expect(request.ip).toBe('198.51.100.7')
      expect(request.ssl).toBe(false)
    })

    it('honours an explicit trustedProxies list', () => {
      global.Odac.Config.request.trustedProxies = []
      const request = new OdacRequest('id', makeReq({...proxyHeaders}, {remoteAddress: '127.0.0.1'}), null, {})
      expect(request.ip).toBe('127.0.0.1')
      expect(request.ssl).toBe(false)
    })

    it('strips the headers from the request either way', () => {
      const req = makeReq({...proxyHeaders}, {remoteAddress: '198.51.100.7'})
      new OdacRequest('id', req, null, {})
      expect(req.headers['x-odac-connection-remoteaddress']).toBeUndefined()
      expect(req.headers['x-odac-connection-ssl']).toBeUndefined()
    })
  })
})
