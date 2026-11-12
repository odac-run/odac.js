const {PassThrough} = require('stream')
const OdacRequest = require('../../src/Request')

// end() sends the response. See IMPROVEMENT-PLAN 3.1: it used to call
// req.connection.destroy() on every request, which tears down the socket and
// defeats keep-alive (Server.js sets keepAliveTimeout=65000), forcing a fresh
// TCP handshake per request. The response must still be sent, but the socket
// must be left alive for the keep-alive path to reuse.

function makeReq(overrides = {}) {
  const req = new PassThrough()
  req.method = overrides.method || 'GET'
  req.url = overrides.url || '/'
  req.headers = Object.assign({host: 'www.example.com'}, overrides.headers)
  req.connection = {remoteAddress: '127.0.0.1', destroy: jest.fn()}
  return req
}

function makeRes() {
  return {writeHead: jest.fn(), end: jest.fn(), finished: false, headersSent: false, on: jest.fn()}
}

let openRequests = []

function build(overrides) {
  const req = makeReq(overrides)
  const res = makeRes()
  const request = new OdacRequest('id', req, res, {setTimeout: (fn, ms) => setTimeout(fn, ms)})
  openRequests.push(request)
  return {req, res, request}
}

describe('Request.end()', () => {
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

  it('sends the response body', () => {
    const {res, request} = build({})
    request.end('hello')
    expect(res.end).toHaveBeenCalledWith('hello')
  })

  it('does not destroy the socket, preserving keep-alive (3.1)', () => {
    const {req, request} = build({})
    request.end('hello')
    expect(req.connection.destroy).not.toHaveBeenCalled()
  })

  // A body sent without Content-Type is sniffed by desktop browsers but handed
  // to the download manager by Android Chrome / iOS Safari — which is how plain
  // string responses (magic-link verify errors, abort() pages) turned into file
  // downloads on mobile.
  it('defaults string bodies to text/html so mobile browsers render instead of download', () => {
    const {res, request} = build({})
    request.end('Verification failed')
    expect(res.writeHead.mock.calls[0][1]['Content-Type']).toBe('text/html; charset=utf-8')
  })

  it('does not override a Content-Type the caller already set', () => {
    const {res, request} = build({})
    request.header('Content-Type', 'text/csv')
    request.end('a,b,c')
    expect(res.writeHead.mock.calls[0][1]['Content-Type']).toBe('text/csv')
  })

  it('does not override a differently-cased Content-Type', () => {
    const {res, request} = build({})
    request.header('content-type', 'text/plain')
    request.end('hello')
    const headers = res.writeHead.mock.calls[0][1]
    expect(headers['content-type']).toBe('text/plain')
    expect(headers['Content-Type']).toBeUndefined()
  })

  it('keeps the JSON content type for object bodies', () => {
    const {res, request} = build({})
    request.end({ok: true})
    expect(res.writeHead.mock.calls[0][1]['Content-Type']).toBe('application/json')
  })

  it.each([
    [42, '42'],
    [0, '0'],
    [true, 'true'],
    [false, 'false']
  ])('sends %p as JSON instead of throwing in res.end()', (value, body) => {
    const {res, request} = build({})
    expect(() => request.end(value)).not.toThrow()
    expect(res.end).toHaveBeenCalledWith(body)
    expect(res.writeHead.mock.calls[0][1]['Content-Type']).toBe('application/json')
  })

  it('leaves buffer bodies untyped', () => {
    const {res, request} = build({})
    request.end(Buffer.from([1, 2, 3]))
    expect(res.writeHead.mock.calls[0][1]['Content-Type']).toBeUndefined()
  })

  it('sends buffers and typed arrays without serializing them', () => {
    const stringify = jest.spyOn(JSON, 'stringify')
    const buffer = Buffer.alloc(1024)
    const first = build({})
    first.request.end(buffer)
    expect(first.res.end).toHaveBeenCalledWith(buffer)

    const bytes = new Uint8Array([1, 2])
    const second = build({})
    second.request.end(bytes)
    expect(second.res.end).toHaveBeenCalledWith(bytes)
    expect(stringify).not.toHaveBeenCalled()
    stringify.mockRestore()
  })

  it('serializes an object whose type field is "Buffer"', () => {
    const {res, request} = build({})
    request.end({type: 'Buffer', name: 'upload'})
    expect(res.end).toHaveBeenCalledWith('{"type":"Buffer","name":"upload"}')
    expect(res.writeHead.mock.calls[0][1]['Content-Type']).toBe('application/json')
  })

  it('serializes object bodies once', () => {
    const parse = jest.spyOn(JSON, 'parse')
    const {res, request} = build({})
    request.end({ok: true, list: [1]})
    expect(res.end).toHaveBeenCalledWith('{"ok":true,"list":[1]}')
    expect(parse).not.toHaveBeenCalled()
    parse.mockRestore()
  })

  it('keeps a JSON media type the caller already set', () => {
    const {res, request} = build({})
    request.header('Content-Type', 'application/problem+json')
    request.end({title: 'Not found'})
    expect(res.writeHead.mock.calls[0][1]['Content-Type']).toBe('application/problem+json')
  })
})

// WebSocket upgrades build a Request with no HTTP response object. Middleware
// shared with HTTP routes may still call end()/abort()/redirect() on it.
describe('Request.end() without an HTTP response', () => {
  beforeEach(() => {
    global.Odac = {Config: {request: {timeout: 5000, maxBodySize: 1e6}}, Route: {routes: {www: {}}}, Request: {}}
  })

  afterEach(() => {
    delete global.Odac
  })

  it('records the request as ended instead of throwing', () => {
    const request = new OdacRequest('id', makeReq(), null, {})
    expect(request.ended).toBe(false)
    expect(() => request.end('bye')).not.toThrow()
    expect(request.ended).toBe(true)
  })

  it('lets redirect() reject a WebSocket request', () => {
    const request = new OdacRequest('id', makeReq(), null, {})
    expect(() => request.redirect('/login')).not.toThrow()
    expect(request.ended).toBe(true)
    expect(request.statusCode).toBe(302)
  })
})

describe('Request.ended', () => {
  beforeEach(() => {
    global.Odac = {Config: {request: {timeout: 5000, maxBodySize: 1e6}}, Route: {routes: {www: {}}}, Request: {}}
  })

  afterEach(() => {
    for (const r of openRequests) r.clearTimeout()
    openRequests = []
    delete global.Odac
  })

  it('reflects the HTTP response state', () => {
    const {res, request} = build({})
    expect(request.ended).toBe(false)
    request.end('ok')
    res.finished = true
    expect(request.ended).toBe(true)
  })
})
