const Route = require('../../../src/Route.js')

describe('MiddlewareChain.use()', () => {
  let route

  beforeEach(() => {
    route = new Route()
    global.Odac = {Route: {buff: 'test'}}
    global.__dir = __dirname
  })

  test('use() should return MiddlewareChain', () => {
    const chain = route.use('auth', 'logger')
    expect(chain).not.toBe(route)
    expect(chain._middlewares).toEqual(['auth', 'logger'])
  })

  test('use() should support chaining with more middlewares', () => {
    const chain = route.use('auth').use('logger')
    expect(chain._middlewares).toEqual(['auth', 'logger'])
  })

  test('auth.use() should return MiddlewareChain', () => {
    const chain = route.auth.use('admin')
    expect(chain).not.toBe(route)
    expect(chain._middlewares).toEqual(['admin'])
  })

  test('separate use() chains should be independent', () => {
    route.use('auth').page('/profile', () => {})
    route.use('cors').page('/api', () => {})
    expect(route.routes.test.page['/profile'].middlewares).toEqual(['auth'])
    expect(route.routes.test.page['/api'].middlewares).toEqual(['cors'])
  })
})
