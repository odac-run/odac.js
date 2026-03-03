const Route = require('../../src/Route')

describe('Route.set()', () => {
  let route

  beforeEach(() => {
    route = new Route()
    global.Odac = {
      Route: {},
      Config: {}
    }
    global.__dir = process.cwd()
  })

  afterEach(() => {
    delete global.Odac
    delete global.__dir
  })

  it('should register a route with function handler', () => {
    global.Odac.Route.buff = 'test_route'
    const handler = jest.fn()

    route.set('get', '/test', handler)

    expect(route.routes.test_route).toBeDefined()
    expect(route.routes.test_route.get).toBeDefined()
    expect(route.routes.test_route.get['/test']).toBeDefined()
    expect(route.routes.test_route.get['/test'].cache).toBe(handler)
    expect(route.routes.test_route.get['/test'].type).toBe('function')
  })

  it('should handle array of methods', () => {
    global.Odac.Route.buff = 'test_route'
    const handler = jest.fn()

    route.set(['get', 'post'], '/test', handler)

    expect(route.routes.test_route.get['/test']).toBeDefined()
    expect(route.routes.test_route.post['/test']).toBeDefined()
  })

  it('should strip trailing slash from url', () => {
    global.Odac.Route.buff = 'test_route'
    const handler = jest.fn()

    route.set('get', '/test/', handler)

    expect(route.routes.test_route.get['/test']).toBeDefined()
    expect(route.routes.test_route.get['/test/']).toBeUndefined()
  })
})
