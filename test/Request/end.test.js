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

  it('leaves buffer bodies untyped', () => {
    const {res, request} = build({})
    request.end(Buffer.from([1, 2, 3]))
    expect(res.writeHead.mock.calls[0][1]['Content-Type']).toBeUndefined()
  })
})
