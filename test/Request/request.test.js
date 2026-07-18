const {PassThrough} = require('stream')
const OdacRequest = require('../../src/Request')

// request(key, method) resolves a request parameter, optionally restricted to a
// single source bucket (post/get/url). See IMPROVEMENT-PLAN 1.5: the method
// filter was broken — the value was upper-cased then compared to lower-case
// literals, so a method-scoped lookup (e.g. request(key, 'get')) never matched
// and resolved undefined even when the data was present.

function makeReq(overrides = {}) {
  const req = new PassThrough()
  req.method = overrides.method || 'GET'
  req.url = overrides.url || '/'
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

describe('Request.request()', () => {
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

  it('returns a GET value when scoped to the get method', async () => {
    const {request} = build({url: '/?foo=bar'})
    expect(await request.request('foo', 'get')).toBe('bar')
  })

  it('is case-insensitive about the method argument', async () => {
    const {request} = build({url: '/?foo=bar'})
    expect(await request.request('foo', 'GET')).toBe('bar')
  })

  it('returns a POST value when scoped to the post method', async () => {
    const {req, request} = build({method: 'POST', headers: {'content-type': 'application/x-www-form-urlencoded'}})
    req.end('name=alice')
    expect(await request.request('name', 'post')).toBe('alice')
  })

  it('finds a value across buckets when no method is given', async () => {
    const {request} = build({url: '/?foo=bar'})
    expect(await request.request('foo')).toBe('bar')
  })

  it('does not return a value from a different bucket than the one requested', async () => {
    const {req, request} = build({method: 'POST', headers: {'content-type': 'application/x-www-form-urlencoded'}})
    req.end('name=alice')
    // name only exists in post; a get-scoped lookup must not return it.
    expect(await request.request('name', 'get')).toBeFalsy()
  })
})
