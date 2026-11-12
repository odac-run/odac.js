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

    it('counts bytes, not characters, against maxBodySize', async () => {
      // 'ş' is two bytes: 3 characters but 6 bytes must exceed a 5-byte limit.
      global.Odac.Config.request.maxBodySize = 5
      const {req, res, request} = build({method: 'POST', headers: {'content-type': 'application/x-www-form-urlencoded'}})
      const pending = request.request('a')
      req.write('a=şşş')
      await expect(pending).resolves.toBeUndefined()
      expect(res.writeHead).toHaveBeenCalledWith(413, expect.anything())
    })
  })

  describe('urlencoded values', () => {
    it('keeps everything after the first "=" in a query value', () => {
      const {request} = build({url: '/?a=abc==&next=/x?y=1'})
      expect(request.data.get.a).toBe('abc==')
      expect(request.data.get.next).toBe('/x?y=1')
    })

    it('decodes "+" as a space in query strings and form bodies', async () => {
      const {req, request} = build({method: 'POST', url: '/?q=hello+world', headers: {'content-type': 'application/x-www-form-urlencoded'}})
      expect(request.data.get.q).toBe('hello world')
      req.end('name=John+Doe&plus=%2B')
      await expect(request.request('name')).resolves.toBe('John Doe')
      expect(request.data.post.plus).toBe('+')
    })

    it('keeps "=" inside form body values', async () => {
      const {req, request} = build({method: 'POST', headers: {'content-type': 'application/x-www-form-urlencoded'}})
      req.end('token=YWJj==')
      await expect(request.request('token')).resolves.toBe('YWJj==')
    })

    it('decodes a multi-byte character split across chunks', async () => {
      const {req, request} = build({method: 'POST', headers: {'content-type': 'application/x-www-form-urlencoded'}})
      const bytes = Buffer.from('city=İstanbul')
      // Split inside the two-byte 'İ' (bytes 5 and 6).
      req.write(bytes.subarray(0, 6))
      req.end(bytes.subarray(6))
      await expect(request.request('city')).resolves.toBe('İstanbul')
    })
  })

  describe('json body', () => {
    it.each(['application/json', 'application/json; charset=utf-8', 'application/vnd.api+json'])(
      'parses the body as JSON for %s',
      async contentType => {
        const {req, request} = build({method: 'POST', headers: {'content-type': contentType}})
        req.end('{"qty":2,"tags":["a"]}')
        await expect(request.request('qty')).resolves.toBe(2)
        expect(request.data.post.tags).toEqual(['a'])
      }
    )

    it('does not parse a JSON-looking body without a JSON content type', async () => {
      const {req, request} = build({method: 'POST', headers: {'content-type': 'text/plain'}})
      req.end('{"role":"admin"}')
      await expect(request.request('role')).resolves.toBeUndefined()
    })

    it('ignores invalid JSON and non-object JSON values', async () => {
      const bad = build({method: 'POST', headers: {'content-type': 'application/json'}})
      bad.req.end('{"a":')
      await expect(bad.request.request()).resolves.toEqual({})

      const scalar = build({method: 'POST', headers: {'content-type': 'application/json'}})
      scalar.req.end('42')
      await expect(scalar.request.request()).resolves.toEqual({})
    })
  })
})
