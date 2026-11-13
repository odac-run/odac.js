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
  // ODAC_APP=true is read once when TrustedProxy loads, so each mode gets its own module registry.
  function load(underOdac) {
    const original = process.env.ODAC_APP
    if (underOdac) process.env.ODAC_APP = 'true'
    else delete process.env.ODAC_APP
    let loaded
    jest.isolateModules(() => {
      loaded = {OdacRequest: require('../../src/Request'), ...require('../../src/Request/TrustedProxy')}
    })
    if (original === undefined) delete process.env.ODAC_APP
    else process.env.ODAC_APP = original
    return loaded
  }

  const proxyHeaders = {host: 'example.com', 'x-odac-connection-remoteaddress': '203.0.113.7', 'x-odac-connection-ssl': 'true'}

  describe('proxy connection headers under ODAC', () => {
    const {OdacRequest: Req} = load(true)

    it('uses the client address and TLS state set by a local proxy', () => {
      const request = new Req('id', makeReq({...proxyHeaders}, {remoteAddress: '::ffff:127.0.0.1'}), null, {})
      expect(request.ip).toBe('203.0.113.7')
      expect(request.ssl).toBe(true)
      expect(request.fromTrustedProxy).toBe(true)
    })

    it('uses the headers from a proxy on a container network', () => {
      const request = new Req('id', makeReq({...proxyHeaders}, {remoteAddress: '172.18.0.2'}), null, {})
      expect(request.ip).toBe('203.0.113.7')
      expect(request.fromTrustedProxy).toBe(true)
    })

    it('ignores the headers when the peer is a public address', () => {
      const request = new Req('id', makeReq({...proxyHeaders}, {remoteAddress: '::ffff:198.51.100.7'}), null, {})
      expect(request.ip).toBe('198.51.100.7')
      expect(request.ssl).toBe(false)
      expect(request.fromTrustedProxy).toBe(false)
    })

    it('honours an explicit empty trustedProxies list', () => {
      global.Odac.Config.request.trustedProxies = []
      const request = new Req('id', makeReq({...proxyHeaders}, {remoteAddress: '172.18.0.2'}), null, {})
      expect(request.ip).toBe('172.18.0.2')
      expect(request.ssl).toBe(false)
    })

    it('strips the headers from the request either way', () => {
      const req = makeReq({...proxyHeaders}, {remoteAddress: '198.51.100.7'})
      new Req('id', req, null, {})
      expect(req.headers['x-odac-connection-remoteaddress']).toBeUndefined()
      expect(req.headers['x-odac-connection-ssl']).toBeUndefined()
    })
  })

  // Only the ODAC proxy writes these headers. Standalone, behind nginx, or through a Docker
  // published port (peer: the private bridge gateway) any client could pick its IP and fake HTTPS.
  describe('proxy connection headers not under ODAC', () => {
    const {OdacRequest: Req} = load(false)

    it.each(['172.17.0.1', '10.0.0.5', '::ffff:127.0.0.1'])('ignores spoofed headers from a private or loopback peer (%s)', peer => {
      const request = new Req('id', makeReq({...proxyHeaders}, {remoteAddress: peer}), null, {})
      expect(request.ip).toBe(peer.replace('::ffff:', ''))
      expect(request.ssl).toBe(false)
      expect(request.fromTrustedProxy).toBe(false)
    })

    it('still strips the headers', () => {
      const req = makeReq({...proxyHeaders}, {remoteAddress: '172.17.0.1'})
      new Req('id', req, null, {})
      expect(req.headers['x-odac-connection-remoteaddress']).toBeUndefined()
      expect(req.headers['x-odac-connection-ssl']).toBeUndefined()
    })

    it('honours an explicit trustedProxies list', () => {
      global.Odac.Config.request.trustedProxies = ['127.0.0.1']
      const request = new Req('id', makeReq({...proxyHeaders}, {remoteAddress: '127.0.0.1'}), null, {})
      expect(request.ip).toBe('203.0.113.7')
      expect(request.ssl).toBe(true)
      expect(request.fromTrustedProxy).toBe(true)
    })

    it('uses the TLS state of the socket itself', () => {
      const request = new Req('id', makeReq({host: 'example.com'}, {remoteAddress: '198.51.100.7', encrypted: true}), null, {})
      expect(request.ssl).toBe(true)
    })
  })

  // A connection on the ODAC proxy's unix socket (ODAC_PROXY_SOCKET) has no peer address.
  describe.each([
    ['under ODAC', true],
    ['not under ODAC', false]
  ])('proxy unix socket %s', (_, underOdac) => {
    const {OdacRequest: Req, markProxySocket} = load(underOdac)

    function socketConnection() {
      const socket = {remoteAddress: undefined}
      markProxySocket(socket)
      return socket
    }

    it('honours the proxy headers on a connection from the proxy socket', () => {
      const request = new Req('id', makeReq({...proxyHeaders}, socketConnection()), null, {})
      expect(request.ip).toBe('203.0.113.7')
      expect(request.ssl).toBe(true)
      expect(request.fromTrustedProxy).toBe(true)
    })

    it('trusts the proxy socket regardless of trustedProxies', () => {
      global.Odac.Config.request.trustedProxies = []
      const request = new Req('id', makeReq({...proxyHeaders}, socketConnection()), null, {})
      expect(request.ip).toBe('203.0.113.7')
      expect(request.fromTrustedProxy).toBe(true)
    })

    it('reads the connection from req.socket as Node sets it', () => {
      global.Odac.Config.request.trustedProxies = []
      const req = makeReq({...proxyHeaders})
      req.socket = socketConnection()
      const request = new Req('id', req, null, {})
      expect(request.ip).toBe('203.0.113.7')
    })

    it('leaves the address empty when the proxy sent none', () => {
      const request = new Req('id', makeReq({host: 'example.com'}, socketConnection()), null, {})
      expect(request.ip).toBe('')
      expect(request.ssl).toBe(false)
    })

    it('does not trust a TCP socket that merely lost its remote address', () => {
      const request = new Req('id', makeReq({...proxyHeaders}, {remoteAddress: undefined}), null, {})
      expect(request.ip).toBe('')
      expect(request.ssl).toBe(false)
      expect(request.fromTrustedProxy).toBe(false)
    })
  })
})
