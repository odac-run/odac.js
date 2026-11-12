const {EventEmitter} = require('events')
const Route = require('../../src/Route')
const OdacRequest = require('../../src/Request')

describe('Route WebSocket methods', () => {
  let route

  beforeEach(() => {
    route = new Route()
  })

  it('should call ws() method successfully', () => {
    const handler = jest.fn()
    expect(() => {
      route.ws('/test', handler, {token: false})
    }).not.toThrow()
  })

  it('should call authWs() method successfully', () => {
    const handler = jest.fn()
    expect(() => {
      route.authWs('/test', handler)
    }).not.toThrow()
  })

  it('registers a socket under the route file being loaded', () => {
    global.Odac = {Route: {buff: 'api'}}
    route.ws('/live', jest.fn(), {token: false})
    delete global.Odac
    expect(route.wsServer.getRoute('/live', 'www')).toBeNull()
    expect(route.wsServer.getRoute('/live', 'api')).toBeTruthy()
    // The subdomain resolves to its route file even when it has no HTTP routes.
    expect(route.routes.api).toEqual({})
  })
})

describe('Route.ws() token', () => {
  it('finds the ODAC token in a protocol list without spaces after commas', async () => {
    const route = new Route()
    route.ws('/chat', jest.fn(), {})
    const ws = Object.assign(new EventEmitter(), {close: jest.fn(), resume: jest.fn()})
    const odac = {
      Request: {_wsHeaders: {'sec-websocket-protocol': 'chat,odac-token-abc'}, ended: false},
      token: jest.fn(value => value === 'abc')
    }
    await route.wsServer.getRoute('/chat').handler(ws, odac)
    expect(odac.token).toHaveBeenCalledWith('abc')
    expect(ws.close).not.toHaveBeenCalled()
    expect(ws.resume).toHaveBeenCalled()
  })
})

// Middleware is shared between HTTP and WebSocket routes. On a WebSocket the
// Request has no HTTP response, so abort()/direct() must reject the connection
// rather than throw or silently let it through.
describe('Route.ws() middleware rejection', () => {
  let route

  function makeWs() {
    const ws = new EventEmitter()
    ws.close = jest.fn()
    ws.resume = jest.fn()
    return ws
  }

  function makeOdac() {
    const req = Object.assign(new EventEmitter(), {
      method: 'GET',
      url: '/chat',
      headers: {host: 'www.example.com'},
      connection: {remoteAddress: '127.0.0.1'}
    })
    const odac = {}
    odac.Request = new OdacRequest('id', req, null, odac)
    odac.abort = code => odac.Request.abort(code)
    odac.direct = url => odac.Request.redirect(url)
    return odac
  }

  async function connect(middleware, handler = jest.fn()) {
    route.use(middleware).ws('/chat', handler, {token: false})
    const ws = makeWs()
    await route.wsServer.getRoute('/chat').handler(ws, makeOdac())
    return {ws, handler}
  }

  beforeEach(() => {
    global.Odac = {Config: {request: {timeout: 5000, maxBodySize: 1e6}}, Route: {routes: {www: {}}}, Request: {}}
    route = new Route()
  })

  afterEach(() => {
    delete global.Odac
  })

  it('closes with 4001 when middleware returns Odac.abort(401)', async () => {
    const {ws, handler} = await connect(Odac => Odac.abort(401))

    expect(ws.close).toHaveBeenCalledWith(4001, 'Unauthorized')
    expect(handler).not.toHaveBeenCalled()
    expect(ws.resume).not.toHaveBeenCalled()
  })

  it('closes with 4003 when middleware returns Odac.abort(403)', async () => {
    const {ws, handler} = await connect(Odac => Odac.abort(403))

    expect(ws.close).toHaveBeenCalledWith(4003, 'Forbidden')
    expect(handler).not.toHaveBeenCalled()
  })

  it('closes with 4000 when middleware redirects', async () => {
    const {ws, handler} = await connect(Odac => Odac.direct('/login'))

    expect(ws.close).toHaveBeenCalledWith(4000, 'Request rejected')
    expect(handler).not.toHaveBeenCalled()
  })

  it('runs the handler when middleware passes', async () => {
    const {ws, handler} = await connect(() => true)

    expect(ws.close).not.toHaveBeenCalled()
    expect(handler).toHaveBeenCalled()
    expect(ws.resume).toHaveBeenCalled()
  })
})
