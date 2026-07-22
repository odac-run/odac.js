const Route = require('../../src/Route')

// Route.request() dispatches an incoming req/res. When the resolved route
// (virtual host) is not configured, it must respond 404 — not an empty 200.
// See IMPROVEMENT-PLAN 4.6.

describe('Route.request()', () => {
  let route
  let param

  beforeEach(() => {
    route = new Route()
    param = {
      Request: {
        route: 'unknown',
        abort: jest.fn(),
        end: jest.fn(),
        print: jest.fn(),
        res: {finished: false, writableEnded: false}
      },
      View: {print: jest.fn()},
      cleanup: jest.fn()
    }
    global.Odac = {
      instance: jest.fn(() => param)
    }
    global.__dir = process.cwd()
  })

  afterEach(() => {
    delete global.Odac
    delete global.__dir
  })

  it('responds 404 for an unconfigured route instead of an empty 200', async () => {
    route.routes = {} // 'unknown' host is not configured
    await route.request({}, {statusCode: 200, end: jest.fn(), destroy: jest.fn()})

    expect(param.Request.abort).toHaveBeenCalledWith(404)
  })
})
