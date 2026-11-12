const {PassThrough} = require('stream')
const OdacRequest = require('../../src/Request')

// The request timeout measures idle time, not total time. A streamed response
// (file download) re-arms it per chunk so a long but progressing transfer is
// never cut. When the timeout does fire after the headers were sent, the 200
// status line is already on the wire: writing an error body would append
// "Request Timeout" to a half-sent file and end it as if it were complete.

const TIMEOUT = 5000

function makeReq() {
  const req = new PassThrough()
  req.method = 'GET'
  req.url = '/download'
  req.headers = {host: 'www.example.com'}
  req.connection = {remoteAddress: '127.0.0.1'}
  return req
}

function makeRes() {
  return {
    writeHead: jest.fn(),
    end: jest.fn(),
    destroy: jest.fn(),
    on: jest.fn(),
    finished: false,
    writableEnded: false,
    headersSent: false
  }
}

function build() {
  const res = makeRes()
  const request = new OdacRequest('id', makeReq(), res, {})
  return {res, request}
}

describe('Request.refreshTimeout()', () => {
  beforeEach(() => {
    jest.useFakeTimers()
    global.Odac = {Config: {request: {timeout: TIMEOUT, maxBodySize: 1e6}}, Route: {routes: {www: {}}}, Request: {}}
  })

  afterEach(() => {
    jest.useRealTimers()
    delete global.Odac
  })

  it('pushes the deadline back so a progressing response is not aborted', () => {
    const {res, request} = build()
    res.headersSent = true

    for (let i = 0; i < 5; i++) {
      jest.advanceTimersByTime(TIMEOUT - 1000)
      request.refreshTimeout()
    }

    expect(res.destroy).not.toHaveBeenCalled()
    expect(res.end).not.toHaveBeenCalled()
  })

  it('destroys the connection instead of appending an error body once headers are sent', () => {
    const {res} = build()
    res.headersSent = true

    jest.advanceTimersByTime(TIMEOUT)

    expect(res.destroy).toHaveBeenCalled()
    expect(res.end).not.toHaveBeenCalled()
  })

  it('still answers 408 when nothing was sent yet', async () => {
    const {res} = build()

    jest.advanceTimersByTime(TIMEOUT)
    await Promise.resolve()

    expect(res.writeHead).toHaveBeenCalledWith(408, expect.any(Object))
    expect(res.end).toHaveBeenCalledWith('Request Timeout')
    expect(res.destroy).not.toHaveBeenCalled()
  })

  it('does nothing once the response has ended', () => {
    const {res, request} = build()
    res.writableEnded = true

    request.refreshTimeout()
    jest.advanceTimersByTime(TIMEOUT)

    expect(res.destroy).not.toHaveBeenCalled()
    expect(res.end).not.toHaveBeenCalled()
  })
})
