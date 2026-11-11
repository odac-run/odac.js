const {PassThrough} = require('stream')
const OdacRequest = require('../../src/Request')

// Sessions are keyed by the odac_session cookie. A request without one must never be attached
// to another visitor's session, even when both share an IP and User-Agent (NAT, CGNAT).

function makeRequest(cookie) {
  const req = new PassThrough()
  req.method = 'GET'
  req.url = '/'
  req.headers = {host: 'example.com', 'user-agent': 'SameBrowser/1.0', ...(cookie ? {cookie} : {})}
  req.socket = {remoteAddress: '203.0.113.5'}
  return new OdacRequest('id', req, null, {})
}

function sessionCookie(request) {
  return request.cookie('odac_session')
}

describe('Request.session()', () => {
  let store

  beforeEach(() => {
    store = new Map()
    global.Odac = {
      Config: {request: {timeout: 5000, maxBodySize: 1e6}},
      Route: {routes: {www: {}}},
      Request: {},
      Storage: {
        get: key => store.get(key),
        put: (key, value) => store.set(key, value),
        remove: key => store.delete(key)
      }
    }
  })

  afterEach(() => {
    delete global.Odac
  })

  it('gives concurrent cookieless visitors with the same IP and User-Agent separate sessions', () => {
    const first = makeRequest()
    first.session('cart', ['first-item'])

    const second = makeRequest()

    expect(second.session('cart')).toBeNull()
    expect(sessionCookie(second)).toBeTruthy()
    expect(sessionCookie(second)).not.toBe(sessionCookie(first))
  })

  it('does not let a cookieless visitor overwrite another session', () => {
    const first = makeRequest()
    first.session('_client', 'first-client')

    const second = makeRequest()
    second.session('_client', 'second-client')

    const firstAgain = makeRequest(`odac_session=${sessionCookie(first)}`)
    expect(firstAgain.session('_client')).toBe('first-client')
  })

  it('keeps one session across calls within the same request', () => {
    const request = makeRequest()
    request.session('a', 1)
    request.session('b', 2)

    const next = makeRequest(`odac_session=${sessionCookie(request)}`)
    expect(next.session('a')).toBe(1)
    expect(next.session('b')).toBe(2)
  })

  it('stores no IP-based lock entries', () => {
    makeRequest().session('x', 1)
    expect([...store.keys()].some(key => key.startsWith('lock:'))).toBe(false)
  })
})
