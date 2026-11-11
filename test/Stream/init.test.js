const {EventEmitter} = require('events')
const {PassThrough} = require('stream')
const OdacRequest = require('../../src/Request')
const Stream = require('../../src/Stream.js')

// An SSE response must carry what the request queued before the stream opened: status,
// custom headers and Set-Cookie (rotated auth tokens). Writing headers on the raw response
// dropped all of them.

function makeRes() {
  const res = new EventEmitter()
  res.headersSent = false
  res.writableEnded = false
  res.finished = false
  res.setTimeout = jest.fn()
  res.setHeader = jest.fn()
  res.writeHead = jest.fn(() => {
    res.headersSent = true
  })
  res.write = jest.fn()
  res.end = jest.fn(() => {
    res.writableEnded = true
  })
  return res
}

function makeRequest(res) {
  const req = new PassThrough()
  req.method = 'GET'
  req.url = '/events'
  req.headers = {host: 'example.com'}
  req.socket = {remoteAddress: '127.0.0.1'}
  req.setTimeout = jest.fn()
  return {req, request: new OdacRequest('id', req, res, {})}
}

describe('Stream headers', () => {
  beforeEach(() => {
    global.Odac = {Config: {request: {timeout: 5000, maxBodySize: 1e6}}, Route: {routes: {www: {}}}, Request: {}}
  })

  afterEach(() => {
    Stream.closeAll()
    delete global.Odac
  })

  it('sends cookies and headers queued on the request with the SSE headers', () => {
    const res = makeRes()
    const {req, request} = makeRequest(res)
    request.cookie('odac_x', 'rotated-x')
    request.header('X-Custom', 'yes')
    request.header('Cache-Control', 'no-store')

    new Stream(req, res, () => {}, {Request: request})

    expect(res.writeHead).toHaveBeenCalledTimes(1)
    const [status, headers] = res.writeHead.mock.calls[0]
    expect(status).toBe(200)
    expect(headers['Content-Type']).toBe('text/event-stream')
    expect(headers['Cache-Control']).toBe('no-cache')
    expect(headers['X-Custom']).toBe('yes')
    expect(headers['Set-Cookie']).toEqual([expect.stringMatching(/^odac_x=rotated-x;/)])
  })

  it('writes headers before the first event', () => {
    const res = makeRes()
    const {req, request} = makeRequest(res)

    new Stream(req, res, send => send('hello'), {Request: request})

    expect(res.writeHead.mock.invocationCallOrder[0]).toBeLessThan(res.write.mock.invocationCallOrder[0])
  })

  it('falls back to raw headers without a request', () => {
    const res = makeRes()
    const req = new EventEmitter()
    req.setTimeout = jest.fn()

    new Stream(req, res, () => {})

    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/event-stream')
  })
})
