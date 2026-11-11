const {PassThrough} = require('stream')
const OdacRequest = require('../../src/Request')

// #data() parses the query string (in the constructor) and the request body
// (on 'end'). Malformed percent-encoding must never throw out and crash the
// worker (Node >=15 exits on unhandled rejection) — see IMPROVEMENT-PLAN 1.1.

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

describe('Request.#data()', () => {
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

  describe('query string', () => {
    it('does not throw on invalid percent-encoding', () => {
      let request
      expect(() => (request = build({url: '/?a=%&b=hello'}).request)).not.toThrow()
      // Falls back to the raw value rather than crashing the process.
      expect(request.data.get.a).toBe('%')
      expect(request.data.get.b).toBe('hello')
    })

    it('decodes valid percent-encoding normally', () => {
      const {request} = build({url: '/?name=hello%20world'})
      expect(request.data.get.name).toBe('hello world')
    })
  })

  describe('urlencoded body', () => {
    it('does not crash on invalid percent-encoding', async () => {
      const {req, request} = build({method: 'POST', headers: {'content-type': 'application/x-www-form-urlencoded'}})
      req.end('a=%ZZ&b=ok')
      const b = await request.request('b')
      expect(b).toBe('ok')
      // The undecodable field survives as its raw value instead of throwing.
      expect(request.data.post.a).toBe('%ZZ')
    })
  })

  // A body-less POST/DELETE must still release callers waiting on the body;
  // otherwise Route.check() awaits forever and the request dies at 408.
  describe('empty body', () => {
    it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('resolves pending request() waiters for a body-less %s', async method => {
      const {req, request} = build({method})
      const pending = request.request('_odac_form_token')
      req.end()
      await expect(pending).resolves.toBeUndefined()
    })

    it('resolves pending file() waiters for a body-less request', async () => {
      const {req, request} = build({method: 'POST'})
      const pending = request.file('avatar')
      req.end()
      await expect(pending).resolves.toBeNull()
    })

    it('resolves request() immediately once the empty body has ended', async () => {
      const {req, request} = build({method: 'DELETE'})
      req.end()
      await new Promise(resolve => setImmediate(resolve))
      await expect(request.request('x')).resolves.toBeUndefined()
    })
  })

  describe('oversized body', () => {
    it('releases pending waiters when the body exceeds maxBodySize', async () => {
      global.Odac.Config.request.maxBodySize = 4
      const {req, res, request} = build({method: 'POST', headers: {'content-type': 'application/x-www-form-urlencoded'}})
      const pending = request.request('a')
      req.write('a=123456789')
      await expect(pending).resolves.toBeUndefined()
      expect(res.writeHead).toHaveBeenCalledWith(413, expect.anything())
    })
  })
})
