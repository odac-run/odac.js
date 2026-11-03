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

    it('does not throw when a token request has no Referer header (1.8)', async () => {
      const mockOdac = {
        Request: {
          url: '/',
          method: 'get',
          route: 'www',
          ssl: false,
          host: 'example.com',
          header: jest.fn(key => {
            // No Referer key: header('Referer') resolves to undefined.
            const headers = {
              'X-Odac': 'token',
              'X-Odac-Client': 'test-client'
            }
            return headers[key]
          }),
          cookie: jest.fn(key => (key === 'odac_client' ? 'test-client' : null)),
          abort: jest.fn()
        },
        token: jest.fn(() => 'test-token')
      }

      route.routes = {www: {}}

      // Missing Referer must not crash the request with a TypeError on .startsWith.
      await expect(route.check(mockOdac)).resolves.not.toThrow()
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

  describe('CSRF token enforcement (1.3)', () => {
    const createMockOdac = (method, url) => ({
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
        request: jest.fn().mockResolvedValue(null),
        res: {finished: false, writableEnded: false},
        route: 'test_route',
        setSession: jest.fn(),
        ssl: false,
        url
      },
      request: jest.fn().mockResolvedValue(null), // no _token / _odac_form_token present
      token: jest.fn().mockReturnValue(true)
    })

    // A token:true route with no CSRF token supplied must be rejected regardless
    // of HTTP verb. Before the fix only post/get were enforced.
    for (const method of ['post', 'get', 'put', 'patch', 'delete']) {
      it(`aborts 401 on a token route with no token via ${method.toUpperCase()}`, async () => {
        const handler = jest.fn().mockReturnValue({ok: true})
        route.routes = {
          test_route: {
            [method]: {
              '/secure': {cache: handler, file: handler, token: true, mtime: Date.now()}
            }
          }
        }

        const mockOdac = createMockOdac(method, '/secure')
        await route.check(mockOdac)

        expect(mockOdac.Request.abort).toHaveBeenCalledWith(401)
        expect(handler).not.toHaveBeenCalled()
      })
    }

    // Route.set() accepts any verb; a fixed allowlist in the check left every
    // other verb's token:true routes unprotected.
    it('aborts 401 on a token route registered under a verb outside the common set', async () => {
      const handler = jest.fn().mockReturnValue({ok: true})
      route.routes = {
        test_route: {
          options: {
            '/secure': {cache: handler, file: handler, token: true, mtime: Date.now()}
          }
        }
      }

      const mockOdac = createMockOdac('options', '/secure')
      await route.check(mockOdac)

      expect(mockOdac.Request.abort).toHaveBeenCalledWith(401)
      expect(handler).not.toHaveBeenCalled()
    })
  })

  // RFC 9110 §9.3.2: HEAD is GET without a body. HEAD resolves GET routes, and
  // every GET guard (auth gate, CSRF token) must apply to it unchanged —
  // otherwise HEAD becomes a token-free way to run GET controller side effects.
  describe('HEAD requests', () => {
    const createMockOdac = (url, {token = null, authed = true} = {}) => ({
      Auth: {check: jest.fn().mockResolvedValue(authed)},
      Config: {},
      Request: {
        abort: jest.fn().mockReturnValue('aborted'),
        cookie: jest.fn(() => null),
        data: {url: {}},
        header: jest.fn(() => ''),
        host: 'example.com',
        isAjaxLoad: false,
        method: 'head',
        page: null,
        request: jest.fn(async key => (key === '_token' ? token : null)),
        res: {finished: false, writableEnded: false},
        route: 'test_route',
        setSession: jest.fn(),
        ssl: false,
        url
      },
      request: jest.fn(async key => (key === '_token' ? token : null)),
      token: jest.fn(value => value === 'valid')
    })

    const getRoute = (handler, token) => ({cache: handler, file: handler, token, mtime: Date.now()})

    it('dispatches to the GET controller', async () => {
      const handler = jest.fn().mockReturnValue({ok: true})
      route.routes = {test_route: {get: {'/status': getRoute(handler, false)}}}

      const mockOdac = createMockOdac('/status')
      const result = await route.check(mockOdac)

      expect(handler).toHaveBeenCalled()
      expect(result).toEqual({ok: true})
      expect(mockOdac.Request.abort).not.toHaveBeenCalled()
    })

    it('keeps Request.method as head so user code can tell it apart from GET', async () => {
      let seenMethod
      const handler = jest.fn(Odac => (seenMethod = Odac.Request.method))
      route.routes = {test_route: {get: {'/status': getRoute(handler, false)}}}

      await route.check(createMockOdac('/status'))

      expect(seenMethod).toBe('head')
    })

    it('resolves parametric GET routes', async () => {
      const handler = jest.fn().mockReturnValue({ok: true})
      global.Odac.Route.buff = 'test_route'
      route.set('get', '/users/{id}', handler, {token: false})
      await Promise.all(route._pendingRouteLoads)

      const mockOdac = createMockOdac('/users/42')
      await route.check(mockOdac)

      expect(handler).toHaveBeenCalled()
      expect(mockOdac.Request.data.url.id).toBe('42')
    })

    it('aborts 401 on a token GET route when no token is supplied', async () => {
      const handler = jest.fn().mockReturnValue({ok: true})
      route.routes = {test_route: {get: {'/secure': getRoute(handler, true)}}}

      const mockOdac = createMockOdac('/secure')
      await route.check(mockOdac)

      expect(mockOdac.Request.abort).toHaveBeenCalledWith(401)
      expect(handler).not.toHaveBeenCalled()
    })

    it('aborts 401 on a token GET route when the token is invalid', async () => {
      const handler = jest.fn().mockReturnValue({ok: true})
      route.routes = {test_route: {get: {'/secure': getRoute(handler, true)}}}

      const mockOdac = createMockOdac('/secure', {token: 'forged'})
      await route.check(mockOdac)

      expect(mockOdac.Request.abort).toHaveBeenCalledWith(401)
      expect(handler).not.toHaveBeenCalled()
    })

    it('runs a token GET route when a valid token is supplied', async () => {
      const handler = jest.fn().mockReturnValue({ok: true})
      route.routes = {test_route: {get: {'/secure': getRoute(handler, true)}}}

      const mockOdac = createMockOdac('/secure', {token: 'valid'})
      await route.check(mockOdac)

      expect(handler).toHaveBeenCalled()
      expect(mockOdac.Request.abort).not.toHaveBeenCalledWith(401)
    })

    it('does not run an auth-only GET route for an unauthenticated request', async () => {
      const handler = jest.fn().mockReturnValue({ok: true})
      route.routes = {test_route: {'#get': {'/account': getRoute(handler, false)}}}

      const mockOdac = createMockOdac('/account', {authed: false})
      await route.check(mockOdac)

      expect(handler).not.toHaveBeenCalled()
      expect(mockOdac.Request.abort).toHaveBeenCalledWith(404)
    })

    it('runs an auth-only GET route for an authenticated request', async () => {
      const handler = jest.fn().mockReturnValue({ok: true})
      route.routes = {test_route: {'#get': {'/account': getRoute(handler, false)}}}

      await route.check(createMockOdac('/account'))

      expect(handler).toHaveBeenCalled()
    })

    it('does not run POST controllers', async () => {
      const handler = jest.fn().mockReturnValue({ok: true})
      route.routes = {test_route: {post: {'/submit': getRoute(handler, false)}}}

      const mockOdac = createMockOdac('/submit')
      await route.check(mockOdac)

      expect(handler).not.toHaveBeenCalled()
      expect(mockOdac.Request.abort).toHaveBeenCalledWith(404)
    })
  })

  // A HEAD response carries no body, so asset paths must answer from file
  // metadata alone: no file read, no read stream opened only to be discarded.
  describe('HEAD on assets', () => {
    const fs = require('fs')
    const path = require('path')

    const createMockOdac = (url, {method = 'head', debug = true} = {}) => ({
      Auth: {check: jest.fn().mockResolvedValue(true)},
      Config: {debug},
      Request: {
        url,
        method,
        route: 'test_route',
        header: jest.fn(),
        cookie: jest.fn(() => null),
        abort: jest.fn(),
        end: jest.fn(),
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

    it('answers a public file from stat without opening a read stream', async () => {
      jest.spyOn(fs.promises, 'stat').mockResolvedValue({isFile: () => true, size: 1024})
      const createReadStream = jest.spyOn(fs, 'createReadStream').mockReturnValue('stream')

      const mockOdac = createMockOdac('/style.css')
      await route.check(mockOdac)

      expect(mockOdac.Request.header).toHaveBeenCalledWith('Content-Type', 'text/css')
      expect(mockOdac.Request.header).toHaveBeenCalledWith('Content-Length', 1024)
      expect(createReadStream).not.toHaveBeenCalled()
      expect(mockOdac.Request.end).toHaveBeenCalledWith()
    })

    it('answers a prod-cached public file without opening a read stream', async () => {
      const stat = jest.spyOn(fs.promises, 'stat').mockResolvedValue({isFile: () => true, size: 2048})
      const createReadStream = jest.spyOn(fs, 'createReadStream').mockReturnValue('stream')

      const mockOdac = createMockOdac('/script.js', {debug: false})
      await route.check(mockOdac) // cache miss: fills the metadata cache
      mockOdac.Request.header.mockClear()
      await route.check(mockOdac) // cache hit

      expect(stat).toHaveBeenCalledTimes(1)
      expect(mockOdac.Request.header).toHaveBeenCalledWith('Content-Length', 2048)
      expect(createReadStream).not.toHaveBeenCalled()
      expect(mockOdac.Request.end).toHaveBeenCalledTimes(2)
    })

    it('answers a config-route file from stat without reading it', async () => {
      jest.spyOn(fs.promises, 'stat').mockResolvedValue({isFile: () => true, size: 50176})
      const readFile = jest.spyOn(fs.promises, 'readFile').mockResolvedValue(Buffer.from(''))

      const mockOdac = createMockOdac('/assets/js/odac.js')
      mockOdac.Config.route = {'/assets/js/odac.js': '/framework/client/odac.js'}
      await route.check(mockOdac)

      expect(readFile).not.toHaveBeenCalled()
      expect(mockOdac.Request.header).toHaveBeenCalledWith('Content-Type', 'text/javascript')
      expect(mockOdac.Request.header).toHaveBeenCalledWith('Content-Length', 50176)
      expect(mockOdac.Request.end).toHaveBeenCalledWith()
    })

    it('continues routing when a config-route target is not a file', async () => {
      jest.spyOn(fs.promises, 'stat').mockResolvedValue({isFile: () => false, size: 0})

      const mockOdac = createMockOdac('/assets/js/odac.js')
      mockOdac.Config.route = {'/assets/js/odac.js': '/framework/client'}
      await route.check(mockOdac)

      expect(mockOdac.Request.end).not.toHaveBeenCalled()
      expect(mockOdac.Request.abort).toHaveBeenCalledWith(404)
    })

    // The prod config cache stores file content. HEAD never reads it, so it must
    // not fill the cache, or the next GET would be served an empty body.
    it('leaves the prod config cache for the next GET to fill', async () => {
      const filePath = path.normalize('/framework/client/odac.js')
      jest.spyOn(fs.promises, 'stat').mockResolvedValue({isFile: () => true, size: 4})
      const readFile = jest.spyOn(fs.promises, 'readFile').mockResolvedValue(Buffer.from('ok()'))

      const head = createMockOdac('/assets/js/odac.js', {debug: false})
      head.Config.route = {'/assets/js/odac.js': filePath}
      await route.check(head)

      const get = createMockOdac('/assets/js/odac.js', {method: 'get', debug: false})
      get.Config.route = {'/assets/js/odac.js': filePath}
      const result = await route.check(get)

      expect(readFile).toHaveBeenCalledTimes(1)
      expect(result.toString()).toBe('ok()')
      expect(get.Request.header).toHaveBeenCalledWith('Content-Length', 4)
    })
  })

  // See IMPROVEMENT-PLAN 3.3: Auth.check() ran unconditionally at the top of
  // check(), so every asset request (config-route files, public files, plain
  // 404s) triggered a token-table query for logged-in users. Auth must instead
  // load lazily at the points where user code can actually run: form
  // processing, controller dispatch, and custom 404 handlers.
  describe('asset requests skip Auth.check (3.3)', () => {
    const fs = require('fs')
    const os = require('os')
    const path = require('path')

    let tmpDir

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'odac-route-check-'))
    })

    afterEach(() => {
      fs.rmSync(tmpDir, {recursive: true, force: true})
    })

    const createMockOdac = (method, url) => ({
      Auth: {check: jest.fn().mockResolvedValue(true)},
      Config: {debug: true},
      Request: {
        abort: jest.fn(),
        cookie: jest.fn(() => null),
        data: {url: {}},
        header: jest.fn(() => undefined),
        host: 'example.com',
        isAjaxLoad: false,
        method,
        page: null,
        res: {finished: false, writableEnded: false},
        route: 'www',
        session: jest.fn(() => null),
        setSession: jest.fn(),
        ssl: false,
        url
      },
      request: jest.fn().mockResolvedValue(null),
      token: jest.fn().mockReturnValue(true)
    })

    it('serves a public file without calling Auth.check', async () => {
      fs.mkdirSync(path.join(tmpDir, 'public'))
      fs.writeFileSync(path.join(tmpDir, 'public', 'style.css'), 'body{}')
      global.__dir = tmpDir
      route.routes = {www: {}}

      const mockOdac = createMockOdac('get', '/style.css')
      const result = await route.check(mockOdac)

      expect(mockOdac.Auth.check).not.toHaveBeenCalled()
      expect(mockOdac.Request.abort).not.toHaveBeenCalled()
      expect(result).toBeDefined()
      // Close the returned read stream fully before afterEach removes tmpDir;
      // a dangling async open would leak an ENOENT into the next test.
      await new Promise(resolve => {
        result.on('error', resolve)
        result.on('close', resolve)
        result.destroy()
      })
    })

    it('serves a config-route file without calling Auth.check', async () => {
      const filePath = path.join(tmpDir, 'app.js')
      fs.writeFileSync(filePath, 'console.log(1)')
      route.routes = {www: {}}

      const mockOdac = createMockOdac('get', '/app.js')
      mockOdac.Config.route = {'/app.js': filePath}
      const result = await route.check(mockOdac)

      expect(mockOdac.Auth.check).not.toHaveBeenCalled()
      expect(result.toString()).toBe('console.log(1)')
    })

    it('aborts 404 without calling Auth.check when no custom 404 handler exists', async () => {
      global.__dir = tmpDir // empty: no public dir
      route.routes = {www: {}}

      const mockOdac = createMockOdac('get', '/missing')
      await route.check(mockOdac)

      expect(mockOdac.Auth.check).not.toHaveBeenCalled()
      expect(mockOdac.Request.abort).toHaveBeenCalledWith(404)
    })

    it('loads the user before dispatching a controller (DX contract)', async () => {
      const order = []
      const handler = jest.fn(() => order.push('handler'))
      route.routes = {www: {get: {'/x': {cache: handler}}}}

      const mockOdac = createMockOdac('get', '/x')
      mockOdac.Auth.check.mockImplementation(async () => {
        order.push('auth')
        return true
      })
      await route.check(mockOdac)

      expect(order).toEqual(['auth', 'handler'])
    })

    it('loads the user before abort(404) when a custom 404 handler exists', async () => {
      global.__dir = tmpDir
      route.routes = {www: {error: {404: {cache: jest.fn()}}}}

      const mockOdac = createMockOdac('get', '/missing')
      await route.check(mockOdac)

      expect(mockOdac.Auth.check).toHaveBeenCalled()
      expect(mockOdac.Request.abort).toHaveBeenCalledWith(404)
    })

    it('loads the user before processing a form post', async () => {
      route.routes = {www: {}}
      global.__dir = tmpDir

      const mockOdac = createMockOdac('post', '/submit')
      mockOdac.request = jest.fn(async key => (key === '_odac_form_token' ? 'tok123' : null))
      await route.check(mockOdac)

      // Form set-callbacks (Odac.fn) are user code and may read Odac.Auth.user().
      expect(mockOdac.Auth.check).toHaveBeenCalled()
    })
  })
})
