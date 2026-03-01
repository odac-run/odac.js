const Route = require('../../../src/Route.js')

describe('Middleware Chaining Integration', () => {
  let route

  beforeEach(() => {
    route = new Route()
    global.Odac = {Route: {buff: 'test'}}
    global.__dir = __dirname
  })

  test('page() should return this for chaining when not on a chain', () => {
    const result = route.page('/', 'index')
    expect(result).toBe(route)
  })

  test('post() should return this for chaining when not on a chain', () => {
    const result = route.post('/api', 'api')
    expect(result).toBe(route)
  })

  test('get() should return this for chaining when not on a chain', () => {
    const result = route.get('/api', 'api')
    expect(result).toBe(route)
  })

  test('chaining should work: use().page().page()', () => {
    route
      .use('auth')
      .page('/profile', () => {})
      .page('/settings', () => {})
    expect(route.routes.test.page['/profile'].middlewares).toEqual(['auth'])
    expect(route.routes.test.page['/settings'].middlewares).toEqual(['auth'])
  })

  test('chaining should work: auth.use().page()', () => {
    route.auth.use('admin').page('/admin', () => {})
    expect(route.routes.test['#page']['/admin'].middlewares).toEqual(['admin'])
  })

  test('middlewares should be attached to routes', () => {
    route
      .use('auth')
      .page('/profile', () => {})
      .page('/settings', () => {})
    expect(route.routes.test.page['/profile'].middlewares).toEqual(['auth'])
    expect(route.routes.test.page['/settings'].middlewares).toEqual(['auth'])
  })

  test('routes without use() should have no middlewares', () => {
    route.use('auth').page('/profile', () => {})
    route.page('/public', () => {})
    expect(route.routes.test.page['/profile'].middlewares).toEqual(['auth'])
    expect(route.routes.test.page['/public'].middlewares).toBeUndefined()
  })

  test('multiple middlewares should be attached', () => {
    route.use('cors', 'rateLimit').post('/api/upload', () => {})
    expect(route.routes.test.post['/api/upload'].middlewares).toEqual(['cors', 'rateLimit'])
  })
})
