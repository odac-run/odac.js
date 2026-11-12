const {PassThrough} = require('stream')
const OdacRequest = require('../../src/Request')

// cookie(key) reads a request cookie. Values containing '=' (base64 / padding)
// must not be truncated, and a malformed JSON-looking value must not throw a
// 500 — see IMPROVEMENT-PLAN 1.9.

function makeReq(overrides = {}) {
  const req = new PassThrough()
  req.method = 'GET'
  req.url = '/'
  req.headers = Object.assign({host: 'www.example.com'}, overrides.headers)
  req.connection = {remoteAddress: '127.0.0.1', destroy: jest.fn()}
  return req
}

function makeRes() {
  return {writeHead: jest.fn(), end: jest.fn(), finished: false, on: jest.fn()}
}

let openRequests = []

function build(overrides) {
  const req = makeReq(overrides)
  const res = makeRes()
  const request = new OdacRequest('id', req, res, {setTimeout: (fn, ms) => setTimeout(fn, ms)})
  openRequests.push(request)
  return {req, res, request}
}

describe('Request.cookie()', () => {
  beforeEach(() => {
    openRequests = []
    global.Odac = {
      Config: {request: {timeout: 5000, maxBodySize: 1e6}},
      Route: {routes: {www: {}}},
      Request: {}
    }
  })

  afterEach(() => {
    for (const r of openRequests) r.clearTimeout()
    openRequests = []
    delete global.Odac
  })

  it('keeps everything after the first "=" (base64 / padded values)', () => {
    const {request} = build({headers: {cookie: 'token=abc=def=='}})
    expect(request.cookie('token')).toBe('abc=def==')
  })

  it('does not throw on a malformed JSON-looking value', () => {
    const {request} = build({headers: {cookie: 'data={not valid json}'}})
    expect(() => request.cookie('data')).not.toThrow()
    // Returns the raw string rather than crashing on JSON.parse.
    expect(request.cookie('data')).toBe('{not valid json}')
  })

  it('parses a valid JSON value into an object', () => {
    const {request} = build({headers: {cookie: 'data={"x":1}'}})
    expect(request.cookie('data')).toEqual({x: 1})
  })

  describe('writing', () => {
    function sent(request) {
      let headers = {}
      request.res = {headersSent: false, writeHead: (status, h) => (headers = h), end: jest.fn(), on: jest.fn()}
      request.print()
      return [].concat(headers['Set-Cookie'] ?? [])
    }

    it('percent-encodes values so they cannot inject attributes', () => {
      const {request} = build()
      request.cookie('name', 'x; Domain=evil.example')
      const [line] = sent(request)
      expect(line.startsWith('name=x%3B%20Domain%3Devil.example;')).toBe(true)
      expect(line).not.toMatch(/; Domain=/)
    })

    it('round-trips encoded values and objects', () => {
      const {request} = build({headers: {cookie: 'name=a%3Bb%20c; obj=%7B%22x%22%3A1%7D'}})
      expect(request.cookie('name')).toBe('a;b c')
      expect(request.cookie('obj')).toEqual({x: 1})
    })

    it('splits the Cookie header with or without a space after ;', () => {
      const {request} = build({headers: {cookie: 'a=1;b=2'}})
      expect(request.cookie('b')).toBe('2')
    })

    it('writes flag attributes without a value and keeps max-age=0', () => {
      const {request} = build()
      request.cookie('a', '1', {'max-age': 0, expires: null})
      const [line] = sent(request)
      expect(line).toBe('a=1; max-age=0; path=/; secure; httpOnly; sameSite=Lax')
    })

    it('rejects invalid names and option values', () => {
      const {request} = build()
      expect(() => request.cookie('a=b', '1')).toThrow(TypeError)
      expect(() => request.cookie('a', '1', {path: '/; Domain=evil'})).toThrow(TypeError)
    })

    it('drops Secure for plain HTTP only in debug mode', () => {
      global.Odac.Config.debug = true
      const {request: dev} = build()
      dev.cookie('a', '1')
      expect(sent(dev)[0]).not.toMatch(/secure/)

      global.Odac.Config.debug = false
      const {request: prod} = build()
      prod.cookie('a', '1')
      expect(sent(prod)[0]).toMatch(/; secure/)
    })
  })
})
