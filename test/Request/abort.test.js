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
})
