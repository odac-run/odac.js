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
})
