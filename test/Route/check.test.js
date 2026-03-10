const Route = require('../../src/Route')

describe('Route.check()', () => {
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

  describe('token request', () => {
    it('should handle token request with undefined route gracefully', async () => {
      const mockOdac = {
        Request: {
          url: '/',
          method: 'get',
          route: 'undefined_route',
          ssl: false,
          host: 'example.com',
          header: jest.fn(key => {
            const headers = {
              'X-Odac': 'token',
              Referer: 'http://example.com/',
              'X-Odac-Client': 'test-client'
            }
            return headers[key]
          }),
          cookie: jest.fn(key => {
            if (key === 'odac_client') return 'test-client'
            return null
          }),
          abort: jest.fn()
        },
        token: jest.fn(() => 'test-token')
      }

      route.routes = {}

      const result = await route.check(mockOdac)

      expect(result).toBeDefined()
      expect(result.token).toBe('test-token')
      expect(result.page).toBeUndefined()
      expect(mockOdac.Request.header).toHaveBeenCalledWith('Access-Control-Allow-Origin', 'http://example.com')
      expect(mockOdac.Request.header).toHaveBeenCalledWith('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
    })

    it('should handle token request with route but no page defined', async () => {
      const mockOdac = {
        Request: {
          url: '/',
          method: 'get',
          route: 'test_route',
          ssl: true,
          host: 'example.com',
          header: jest.fn(key => {
            const headers = {
              'X-Odac': 'token',
              Referer: 'https://example.com/',
              'X-Odac-Client': 'test-client'
            }
            return headers[key]
          }),
          cookie: jest.fn(key => {
            if (key === 'odac_client') return 'test-client'
            return null
          }),
          abort: jest.fn()
        },
        token: jest.fn(() => 'test-token-2')
      }

      route.routes = {
        test_route: {}
      }

      const result = await route.check(mockOdac)

      expect(result).toBeDefined()
      expect(result.token).toBe('test-token-2')
      expect(result.page).toBeUndefined()
    })

    it('should handle token request with route and page but no url match', async () => {
      const mockOdac = {
        Request: {
          url: '/',
          method: 'get',
          route: 'test_route',
          ssl: false,
          host: 'example.com',
          header: jest.fn(key => {
            const headers = {
              'X-Odac': 'token',
              Referer: 'http://example.com/',
              'X-Odac-Client': 'test-client'
            }
            return headers[key]
          }),
          cookie: jest.fn(key => {
            if (key === 'odac_client') return 'test-client'
            return null
          }),
          abort: jest.fn()
        },
        token: jest.fn(() => 'test-token-3')
      }

      route.routes = {
        test_route: {
          page: {
            '/other': {file: 'other.js'}
          }
        }
      }

      const result = await route.check(mockOdac)

      expect(result).toBeDefined()
      expect(result.token).toBe('test-token-3')
      expect(result.page).toBeUndefined()
    })

    it('should not return token when referer does not match', async () => {
      const mockOdac = {
        Request: {
          url: '/',
          method: 'get',
          route: 'test_route',
          ssl: false,
          host: 'example.com',
          header: jest.fn(key => {
            const headers = {
              'X-Odac': 'token',
              Referer: 'http://malicious.com/',
              'X-Odac-Client': 'test-client'
            }
            return headers[key]
          }),
          cookie: jest.fn(key => {
            if (key === 'odac_client') return 'test-client'
            return null
          }),
          abort: jest.fn()
        },
        Config: {},
        token: jest.fn(() => 'test-token')
      }

      route.routes = {
        test_route: {
          page: {}
        }
      }

      await route.check(mockOdac)

      expect(mockOdac.Request.header).not.toHaveBeenCalledWith('Access-Control-Allow-Origin', expect.any(String))
    })

    it('should not return token when client cookie does not match', async () => {
      const mockOdac = {
        Request: {
          url: '/',
          method: 'get',
          route: 'test_route',
          ssl: false,
          host: 'example.com',
          header: jest.fn(key => {
            const headers = {
              'X-Odac': 'token',
              Referer: 'http://example.com/',
              'X-Odac-Client': 'test-client'
            }
            return headers[key]
          }),
          cookie: jest.fn(key => {
            if (key === 'odac_client') return 'different-client'
            return null
          }),
          abort: jest.fn()
        },
        Config: {},
        token: jest.fn(() => 'test-token')
      }

      route.routes = {
        test_route: {
          page: {}
        }
      }

      await route.check(mockOdac)

      expect(mockOdac.Request.header).not.toHaveBeenCalledWith('Access-Control-Allow-Origin', expect.any(String))
    })
  })

  describe('parametric route matching', () => {
    const createMockOdac = (url, method = 'get') => ({
      Auth: {check: jest.fn().mockResolvedValue(true)},
      Config: {},
      Request: {
        abort: jest.fn().mockReturnValue('aborted'),
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

    const setupParamRoute = async (routeInstance, urlPattern, handler) => {
      global.Odac.Route.buff = 'test_route'
      routeInstance.set('get', urlPattern, handler, {token: false})
      await Promise.all(routeInstance._pendingRouteLoads)
      routeInstance._pendingRouteLoads = []
    }

    it('should match single parametric segment and extract params', async () => {
      const handler = jest.fn().mockReturnValue({ok: true})
      await setupParamRoute(route, '/users/{id}', handler)

      const mockOdac = createMockOdac('/users/42')
      await route.check(mockOdac)

      expect(handler).toHaveBeenCalled()
      expect(mockOdac.Request.data.url.id).toBe('42')
    })

    it('should match multi-parameter route and extract all params', async () => {
      const handler = jest.fn().mockReturnValue({ok: true})
      await setupParamRoute(route, '/users/{userId}/posts/{postId}', handler)

      const mockOdac = createMockOdac('/users/7/posts/99')
      await route.check(mockOdac)

      expect(handler).toHaveBeenCalled()
      expect(mockOdac.Request.data.url.userId).toBe('7')
      expect(mockOdac.Request.data.url.postId).toBe('99')
    })

    it('should not match when static segments differ', async () => {
      const handler = jest.fn().mockReturnValue({ok: true})
      await setupParamRoute(route, '/users/{id}', handler)

      const mockOdac = createMockOdac('/posts/42')
      await route.check(mockOdac)

      expect(handler).not.toHaveBeenCalled()
    })

    it('should not match when segment count differs', async () => {
      const handler = jest.fn().mockReturnValue({ok: true})
      await setupParamRoute(route, '/users/{id}', handler)

      const mockOdac = createMockOdac('/users/42/extra')
      await route.check(mockOdac)

      expect(handler).not.toHaveBeenCalled()
    })

    it('should correctly match among multiple parametric routes (no arr mutation bug)', async () => {
      const usersHandler = jest.fn().mockReturnValue({users: true})
      const postsHandler = jest.fn().mockReturnValue({posts: true})

      await setupParamRoute(route, '/users/{id}', usersHandler)
      await setupParamRoute(route, '/posts/{id}', postsHandler)

      // Request to /posts/5 should match postsHandler, not usersHandler
      const mockOdac = createMockOdac('/posts/5')
      await route.check(mockOdac)

      expect(usersHandler).not.toHaveBeenCalled()
      expect(postsHandler).toHaveBeenCalled()
      expect(mockOdac.Request.data.url.id).toBe('5')
    })

    it('should prefer exact match over parametric match', async () => {
      const exactHandler = jest.fn().mockReturnValue({exact: true})
      const paramHandler = jest.fn().mockReturnValue({param: true})

      await setupParamRoute(route, '/users/admin', exactHandler)
      await setupParamRoute(route, '/users/{id}', paramHandler)

      const mockOdac = createMockOdac('/users/admin')
      await route.check(mockOdac)

      expect(exactHandler).toHaveBeenCalled()
      expect(paramHandler).not.toHaveBeenCalled()
    })
  })

  describe('public static file serving', () => {
    const fs = require('fs')
    const path = require('path')

    const createMockOdac = url => ({
      Auth: {check: jest.fn().mockResolvedValue(true)},
      Config: {debug: true},
      Request: {
        url,
        method: 'get',
        route: 'test_route',
        header: jest.fn(),
        cookie: jest.fn(() => null),
        abort: jest.fn(),
        setSession: jest.fn(),
        data: {url: {}}
      },
      request: jest.fn().mockResolvedValue(null)
    })

    beforeEach(() => {
      global.__dir = '/app'
    })

    afterEach(() => {
      jest.restoreAllMocks()
    })

    it('should serve a public static file successfully', async () => {
      const mockStat = jest.spyOn(fs.promises, 'stat').mockResolvedValue({isFile: () => true, size: 1024})
      const mockStream = {pipe: jest.fn()}
      const mockCreateReadStream = jest.spyOn(fs, 'createReadStream').mockReturnValue(mockStream)
      const expectedPath = path.normalize('/app/public/style.css')

      const mockOdac = createMockOdac('/style.css')
      const result = await route.check(mockOdac)

      expect(mockStat).toHaveBeenCalledWith(expectedPath)
      expect(mockOdac.Request.header).toHaveBeenCalledWith('Content-Type', 'text/css')
      expect(mockOdac.Request.header).toHaveBeenCalledWith('Content-Length', 1024)
      expect(mockCreateReadStream).toHaveBeenCalledWith(expectedPath)
      expect(result).toBe(mockStream)
    })

    it('should prevent path traversal attacks', async () => {
      const mockStat = jest.spyOn(fs.promises, 'stat')

      const mockOdac = createMockOdac('/../secrets.txt')
      const result = await route.check(mockOdac)

      expect(mockStat).not.toHaveBeenCalled()
      expect(result).toBeUndefined() // Falls through if blocked
    })

    it('should prevent null byte injection attacks', async () => {
      const mockStat = jest.spyOn(fs.promises, 'stat')

      const mockOdac = createMockOdac('/style%00.css')
      const result = await route.check(mockOdac)

      expect(mockStat).not.toHaveBeenCalled()
      expect(result).toBeUndefined()
    })

    it('should handle invalid URI encoding gracefully', async () => {
      const mockStat = jest.spyOn(fs.promises, 'stat')

      const mockOdac = createMockOdac('/%E0%A4%A') // Invalid URL encoded string
      const result = await route.check(mockOdac)

      expect(mockStat).not.toHaveBeenCalled()
      expect(result).toBeUndefined()
    })

    it('should cache metadata in production mode', async () => {
      jest.spyOn(fs.promises, 'stat').mockResolvedValue({isFile: () => true, size: 2048})
      const mockCreateReadStream = jest.spyOn(fs, 'createReadStream').mockReturnValue('mock_stream')

      const mockOdac = createMockOdac('/script.js')
      mockOdac.Config.debug = false // prod mode

      // first call (cache miss -> set cache)
      await route.check(mockOdac)
      expect(fs.promises.stat).toHaveBeenCalledTimes(1)
      expect(mockOdac.Request.header).toHaveBeenCalledWith('Content-Type', 'text/javascript')

      // reset mock tracking (cache hit -> no stat)
      jest.clearAllMocks()
      jest.spyOn(fs, 'createReadStream').mockReturnValue('mock_stream_2')

      // second call
      const result2 = await route.check(mockOdac)

      expect(fs.promises.stat).not.toHaveBeenCalled() // Not called because metadata is cached
      expect(mockOdac.Request.header).toHaveBeenCalledWith('Content-Type', 'text/javascript')
      expect(mockOdac.Request.header).toHaveBeenCalledWith('Content-Length', 2048)
      expect(mockCreateReadStream).toHaveBeenCalledWith(path.normalize('/app/public/script.js'))
      expect(result2).toBe('mock_stream_2')
    })
  })
})
