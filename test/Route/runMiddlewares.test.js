const Route = require('../../src/Route')

// #runMiddlewares runs a route's middleware chain before its controller. It is
// private but reachable through the public check(). See IMPROVEMENT-PLAN 2.7:
// when a named middleware could not be resolved it called Request.abort(500)
// but returned its (undefined) result, so #executeController's `!== undefined`
// guard let the controller run anyway — a response was sent AND the handler
// executed its side effects.

describe('Route.#runMiddlewares()', () => {
  let route

  beforeEach(() => {
    route = new Route()
    global.Odac = {Route: {}, Config: {}}
    global.__dir = process.cwd()
    jest.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    jest.restoreAllMocks()
    delete global.Odac
    delete global.__dir
  })

  const createMockOdac = (method, url) => ({
    Auth: {check: jest.fn().mockResolvedValue(true)},
    Config: {},
    Request: {
      // Real abort() resolves to undefined; mirror that so the guard is exercised.
      abort: jest.fn(),
      cookie: jest.fn(() => null),
      data: {url: {}},
      header: jest.fn(() => ''),
      host: 'example.com',
      isAjaxLoad: false,
      method,
      page: null,
      res: {finished: false, writableEnded: false},
      route: 'test_route',
      setSession: jest.fn(),
      ssl: false,
      url
    },
    request: jest.fn().mockResolvedValue(null),
    token: jest.fn().mockReturnValue(true)
  })

  it('aborts 500 and does not run the controller when a middleware is missing (2.7)', async () => {
    const handler = jest.fn().mockReturnValue({ok: true})
    route.routes = {
      test_route: {get: {'/x': {cache: handler, middlewares: ['ghost']}}}
    }

    const mockOdac = createMockOdac('get', '/x')
    await route.check(mockOdac)

    expect(mockOdac.Request.abort).toHaveBeenCalledWith(500)
    expect(handler).not.toHaveBeenCalled()
  })

  it('runs the controller when middleware passes (returns undefined)', async () => {
    const handler = jest.fn().mockReturnValue({ok: true})
    const mw = jest.fn().mockReturnValue(undefined)
    route.routes = {
      test_route: {get: {'/x': {cache: handler, middlewares: [mw]}}}
    }

    const mockOdac = createMockOdac('get', '/x')
    await route.check(mockOdac)

    expect(mw).toHaveBeenCalled()
    expect(handler).toHaveBeenCalledTimes(1)
  })
})
