const {PassThrough} = require('stream')
const OdacRequest = require('../../src/Request')

function makeReq() {
  const req = new PassThrough()
  req.method = 'GET'
  req.url = '/ws'
  req.headers = {host: 'www.example.com'}
  req.connection = {remoteAddress: '127.0.0.1'}
  return req
}

describe('Request.abort()', () => {
  beforeEach(() => {
    global.Odac = {Config: {request: {timeout: 5000, maxBodySize: 1e6}}, Route: {routes: {www: {}}}, Request: {}}
  })

  afterEach(() => {
    delete global.Odac
  })

  // A WebSocket upgrade has no HTTP response. abort() from shared middleware
  // used to dereference res and throw, crashing the worker.
  describe('without an HTTP response (WebSocket upgrade)', () => {
    it('marks the request ended with the abort status', async () => {
      const request = new OdacRequest('id', makeReq(), null, {})

      await expect(request.abort(401)).resolves.toBeUndefined()

      expect(request.ended).toBe(true)
      expect(request.statusCode).toBe(401)
    })

    it('skips custom HTTP error pages', async () => {
      const cache = jest.fn()
      global.Odac.Route.routes.www.error = {404: {cache}}
      const odac = {Route: global.Odac.Route}
      const request = new OdacRequest('id', makeReq(), null, odac)

      await request.abort(404)

      expect(cache).not.toHaveBeenCalled()
      expect(request.ended).toBe(true)
    })
  })

  describe('with an HTTP response', () => {
    function makeRes() {
      const res = {
        headersSent: false,
        writableEnded: false,
        finished: false,
        body: undefined,
        status: null,
        on: jest.fn(),
        destroy: jest.fn(),
        writeHead: jest.fn(status => {
          res.status = status
          res.headersSent = true
        }),
        end: jest.fn(body => {
          res.body = body
          res.writableEnded = res.finished = true
        })
      }
      return res
    }

    function build(error, view) {
      const res = makeRes()
      if (error) global.Odac.Route.routes.www.error = error
      const odac = {Route: global.Odac.Route, View: view, setTimeout: () => null}
      const request = new OdacRequest('id', makeReq(), res, odac)
      return {request, res}
    }

    it('renders the view a custom handler configured instead of leaving the response open', async () => {
      const view = {print: jest.fn(async () => request.end('<h1>Timed out</h1>'))}
      const {request, res} = build({408: {cache: jest.fn(() => undefined)}}, view)

      await request.abort(408)

      expect(view.print).toHaveBeenCalled()
      expect(res.status).toBe(408)
      expect(res.body).toBe('<h1>Timed out</h1>')
    })

    it('falls back to the plain status page when the handler sets nothing', async () => {
      const view = {print: jest.fn(async () => {})}
      const {request, res} = build({408: {cache: jest.fn(() => undefined)}}, view)

      await request.abort(408)

      expect(res.status).toBe(408)
      expect(res.body).toBe('Request Timeout')
    })

    it('falls back to the plain status page when the handler throws', async () => {
      const spy = jest.spyOn(console, 'error').mockImplementation(() => {})
      const {request, res} = build({500: {cache: jest.fn(() => Promise.reject(new Error('boom')))}})

      await request.abort(500)

      expect(res.status).toBe(500)
      expect(res.end).toHaveBeenCalled()
      spy.mockRestore()
    })

    it('drops the connection instead of throwing once headers are sent', async () => {
      const {request, res} = build()
      res.headersSent = true

      await expect(request.abort(500)).resolves.toBeUndefined()

      expect(res.destroy).toHaveBeenCalled()
      expect(res.writeHead).not.toHaveBeenCalled()
    })
  })
})
