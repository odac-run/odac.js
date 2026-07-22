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
})
