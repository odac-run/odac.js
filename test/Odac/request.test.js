const {PassThrough} = require('stream')
const Odac = require('../../src/Odac')

// The _odac.request(key, method) shortcut must forward BOTH arguments to
// Request.request(key, method). See IMPROVEMENT-PLAN 4.2: the shortcut dropped
// the method parameter, so a method-scoped lookup silently fell back to
// searching every bucket (post → get → url).

describe('Odac.request()', () => {
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

  function makeCtx() {
    const req = new PassThrough()
    req.method = 'POST'
    req.url = '/?foo=bar' // foo lands in the query (get) bucket only
    req.headers = {host: 'www.example.com', 'content-type': 'application/x-www-form-urlencoded'}
    req.connection = {remoteAddress: '127.0.0.1', destroy: jest.fn()}
    const res = {on: jest.fn(), writeHead: jest.fn(), end: jest.fn(), finished: false}
    ctx = Odac.instance('id', req, res)
    req.end('other=1') // body completes (no foo) so post-scoped lookups can resolve
    return ctx
  }

  it('forwards the method argument so a get-scoped lookup resolves the value', async () => {
    makeCtx()
    expect(await ctx.request('foo', 'get')).toBe('bar')
  })

  it('forwards the method argument so a post-scoped lookup does not fall back to the get bucket', async () => {
    makeCtx()
    // foo only exists in the query (get) bucket; a post-scoped lookup must not
    // return it. With the method dropped, request() searched every bucket and
    // wrongly returned 'bar'.
    expect(await ctx.request('foo', 'post')).toBeFalsy()
  })
})
