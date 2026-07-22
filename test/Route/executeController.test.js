const Route = require('../../src/Route')

// #executeController runs the matched controller. It is private but reachable
// through the public check(). See IMPROVEMENT-PLAN 1.4: the whole "instantiate
// + invoke action" was wrapped in one try/catch, so a controller whose action
// threw synchronously fell into the catch and the action was invoked a SECOND
// time statically (double side effects), while the real error was swallowed.

describe('Route.#executeController()', () => {
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

  const mount = controller => {
    route.routes = {test_route: {get: {'/x': controller}}}
  }

  it('runs a class instance-method controller once (success path)', async () => {
    const handler = jest.fn().mockReturnValue({ok: true})
    class Ctrl {
      handle(Odac) {
        return handler(Odac)
      }
    }
    mount({cache: Ctrl, action: 'handle'})

    await route.check(createMockOdac('get', '/x'))
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('does not re-run the action statically when it throws (1.4)', async () => {
    const calls = []
    function Ctrl() {}
    Ctrl.prototype.handle = function () {
      calls.push('instance')
      throw new Error('boom')
    }
    // Same-named static method: the old catch fallback would invoke this too.
    Ctrl.handle = function () {
      calls.push('static')
    }
    mount({cache: Ctrl, action: 'handle'})

    // The real error must propagate (not be swallowed into a silent 500)...
    await expect(route.check(createMockOdac('get', '/x'))).rejects.toThrow('boom')
    // ...and the action must run exactly once.
    expect(calls).toEqual(['instance'])
  })

  it('still supports non-constructor controllers via static resolution', async () => {
    const handler = jest.fn().mockReturnValue({ok: true})
    // A plain object of handlers: `new controllerObj()` throws, so the action
    // must be resolved statically.
    const controllerObj = {handle: handler}
    mount({cache: controllerObj, action: 'handle'})

    await route.check(createMockOdac('get', '/x'))
    expect(handler).toHaveBeenCalledTimes(1)
  })
})
