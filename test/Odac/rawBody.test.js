const {PassThrough} = require('stream')
const Odac = require('../../src/Odac')

describe('Odac.rawBody()', () => {
  let ctx

  beforeEach(() => {
    global.Odac = {
      Config: {request: {timeout: 5000, maxBodySize: 1e6}},
      Route: {routes: {www: {}}},
      Env: {get: jest.fn()}
    }
    global.__dir = '/mock'
  })

  afterEach(() => {
    ctx?.Request.clearTimeout()
    ctx = null
    delete global.Odac
    delete global.__dir
  })

  function makeCtx(body, contentType = 'application/json') {
    const req = new PassThrough()
    req.method = 'POST'
    req.url = '/webhook'
    req.headers = {host: 'www.example.com', 'content-type': contentType}
    req.connection = {remoteAddress: '127.0.0.1', destroy: jest.fn()}
    const res = {on: jest.fn(), writeHead: jest.fn(), end: jest.fn(), finished: false}
    ctx = Odac.instance('id', req, res)
    req.end(body)
    return ctx
  }

  it('exposes rawBody() as a shorthand on the instance and returns the raw Buffer', async () => {
    const payload = '{"event":"payment.succeeded","id":42}'
    makeCtx(payload)

    expect(typeof ctx.rawBody).toBe('function')
    const raw = await ctx.rawBody()
    expect(Buffer.isBuffer(raw)).toBe(true)
    expect(raw.toString('utf8')).toBe(payload)
  })

  it('forwards the encoding argument to Request.rawBody()', async () => {
    const payload = '{"event":"payment.succeeded"}'
    makeCtx(payload)

    expect(await ctx.rawBody('utf8')).toBe(payload)
  })
})
