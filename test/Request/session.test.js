const {PassThrough} = require('stream')
const OdacRequest = require('../../src/Request')

// Sessions are keyed by the odac_session cookie. A request without one must never be attached
// to another visitor's session, even when both share an IP and User-Agent (NAT, CGNAT).

function makeRequest(cookie, userAgent = 'SameBrowser/1.0') {
  const req = new PassThrough()
  req.method = 'GET'
  req.url = '/'
  req.headers = {host: 'example.com', 'user-agent': userAgent, ...(cookie ? {cookie} : {})}
  req.socket = {remoteAddress: '203.0.113.5'}
  return new OdacRequest('id', req, null, {})
}

function sessionCookie(request) {
  return request.cookie('odac_session')
}

// The Set-Cookie line this request would send for `name`.
function sentCookie(request, name) {
  let headers = {}
  request.res = {headersSent: false, writeHead: (status, sent) => (headers = sent)}
  request.print()
  return [].concat(headers['Set-Cookie'] ?? []).find(line => line.startsWith(`${name}=`)) ?? null
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
        entries: prefix => new Map([...store].filter(([key]) => key.startsWith(prefix))),
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
    second.session('cart', ['second-item'])

    expect(sessionCookie(second)).toBeTruthy()
    expect(sessionCookie(second)).not.toBe(sessionCookie(first))
  })

  describe('lazy creation', () => {
    it('creates no session record for a request that only reads', () => {
      const request = makeRequest()
      expect(request.session('cart')).toBeNull()
      expect(store.size).toBe(0)
      expect(sentCookie(request, 'odac_session')).toBeNull()
    })

    it('issues the client cookie without a record and persists it with the first write', () => {
      const request = makeRequest()
      request.setSession()
      const client = request.cookie('odac_client')
      expect(client).toMatch(/^[0-9a-f]{32}$/)
      expect(store.size).toBe(0)
      expect(request.session('_client')).toBe(client)

      request.session('cart', ['item'])
      const next = makeRequest(`odac_session=${sessionCookie(request)}; odac_client=${client}`)
      expect(next.session('_client')).toBe(client)
      next.setSession()
      expect(next.cookie('odac_client')).toBe(client)
    })
  })

  describe('sliding expiry', () => {
    const HOUR = 60 * 60 * 1000

    afterEach(() => jest.useRealTimers())

    it('records activity at most once per hour and refreshes the cookie lifetime with it', () => {
      jest.useFakeTimers({now: 1_800_000_000_000})
      const first = makeRequest()
      first.session('x', 1)
      const id = sessionCookie(first)
      const activeKey = [...store.keys()].find(key => key.endsWith(':_created')).replace('_created', '_active')
      expect(sentCookie(first, 'odac_session')).toContain(new Date(Date.now() + 7 * 24 * HOUR).toUTCString())

      jest.setSystemTime(Date.now() + 30 * 60 * 1000)
      const soon = makeRequest(`odac_session=${id}`)
      expect(soon.session('x')).toBe(1)
      expect(store.has(activeKey)).toBe(false)
      expect(sentCookie(soon, 'odac_session')).toBeNull()

      jest.setSystemTime(Date.now() + 2 * HOUR)
      const later = makeRequest(`odac_session=${id}`)
      expect(later.session('x')).toBe(1)
      expect(store.get(activeKey)).toBe(Date.now())
      expect(sentCookie(later, 'odac_session')).toContain(new Date(Date.now() + 7 * 24 * HOUR).toUTCString())
    })
  })

  describe('User-Agent binding', () => {
    const chrome = v => `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${v} Safari/537.36`

    it('keeps the session across a browser version update', () => {
      const before = makeRequest(null, chrome('120.0.0.0'))
      before.session('cart', ['item'])
      const after = makeRequest(`odac_session=${sessionCookie(before)}`, chrome('121.0.6167.85'))
      expect(after.session('cart')).toEqual(['item'])
    })

    it('does not resolve the session from another browser', () => {
      const before = makeRequest(null, chrome('120.0.0.0'))
      before.session('cart', ['item'])
      const other = makeRequest(
        `odac_session=${sessionCookie(before)}`,
        'Mozilla/5.0 (X11; Linux x86_64; rv:121.0) Gecko/20100101 Firefox/121.0'
      )
      expect(other.session('cart')).toBeNull()
    })

    it('moves a session keyed by the full User-Agent to the version-free key', () => {
      const ua = chrome('120.0.0.0')
      const fullHash = require('crypto').createHash('sha256').update(ua).digest('hex')
      store.set(`sess:abc:${fullHash}:_created`, Date.now())
      store.set(`sess:abc:${fullHash}:cart`, ['old'])

      const request = makeRequest('odac_session=abc', ua)
      expect(request.session('cart')).toEqual(['old'])
      expect([...store.keys()].some(key => key.includes(fullHash))).toBe(false)
      expect(makeRequest('odac_session=abc', ua).session('cart')).toEqual(['old'])
    })
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

  describe('regenerateSession()', () => {
    it('moves the data to a new identifier and retires the old one', () => {
      const before = makeRequest()
      before.session('cart', ['item'])
      const planted = sessionCookie(before)

      const login = makeRequest(`odac_session=${planted}`)
      login.regenerateSession()
      const fresh = sessionCookie(login)

      expect(fresh).not.toBe(planted)
      expect(login.session('cart')).toEqual(['item'])
      expect(makeRequest(`odac_session=${fresh}`).session('cart')).toEqual(['item'])
      // The planted identifier no longer resolves: a request with it starts a new session.
      const attacker = makeRequest(`odac_session=${planted}`)
      expect(attacker.session('cart')).toBeNull()
      attacker.session('cart', ['other'])
      expect(sessionCookie(attacker)).not.toBe(planted)
    })

    it('keeps values written earlier in the same request', () => {
      const request = makeRequest()
      request.session('step', 1)
      request.regenerateSession()
      expect(request.session('step')).toBe(1)
    })

    it('creates a session when the visitor had none', () => {
      const request = makeRequest()
      request.regenerateSession()
      expect(sessionCookie(request)).toBeTruthy()
      expect(makeRequest(`odac_session=${sessionCookie(request)}`).session('x')).toBeNull()
    })
  })

  it('stores no IP-based lock entries', () => {
    makeRequest().session('x', 1)
    expect([...store.keys()].some(key => key.startsWith('lock:'))).toBe(false)
  })
})
