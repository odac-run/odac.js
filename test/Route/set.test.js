const Route = require('../../src/Route')
const path = require('path')
const fs = require('fs')
const os = require('os')

describe('Route.set()', () => {
  let route
  let consoleSpy

  beforeEach(() => {
    route = new Route()
    global.Odac = {
      Route: {},
      Config: {}
    }
    global.__dir = process.cwd()
    consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    consoleSpy.mockRestore()
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

  it('should log "Controller not found" when file does not exist', async () => {
    global.Odac.Route.buff = 'test_route'

    route.set('get', '/missing', 'nonexistent_controller')

    await Promise.all(route._pendingRouteLoads)

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Controller not found'))
  })

  it('should log the actual error message when controller has a load error', async () => {
    global.Odac.Route.buff = 'test_route'

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'odac-test-'))
    const controllerDir = path.join(tmpDir, 'controller', 'get')
    fs.mkdirSync(controllerDir, {recursive: true})
    fs.writeFileSync(path.join(controllerDir, 'broken.js'), "const x = require('nonexistent_module_xyz_12345');")

    global.__dir = tmpDir

    route.set('get', '/broken', 'broken')

    await Promise.all(route._pendingRouteLoads)

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to load controller'))
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('nonexistent_module_xyz_12345'))

    fs.rmSync(tmpDir, {recursive: true, force: true})
  })
})
