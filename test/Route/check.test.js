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

    it('percent-decodes parameter values', async () => {
      const handler = jest.fn().mockReturnValue({ok: true})
      await setupParamRoute(route, '/user/{name}/{slug}', handler)

      const mockOdac = createMockOdac('/user/John%20Doe/a%2Fb%C3%BC')
      await route.check(mockOdac)

      expect(handler).toHaveBeenCalled()
      expect(mockOdac.Request.data.url.name).toBe('John Doe')
      expect(mockOdac.Request.data.url.slug).toBe('a/bü')
    })

    it('keeps a malformed escape as sent', async () => {
      const handler = jest.fn().mockReturnValue({ok: true})
      await setupParamRoute(route, '/user/{name}', handler)

      const mockOdac = createMockOdac('/user/100%')
      await route.check(mockOdac)

      expect(mockOdac.Request.data.url.name).toBe('100%')
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

    it('should prevent path traversal attacks', async () => {
      const mockOpen = jest.spyOn(fs.promises, 'open')

      const mockOdac = createMockOdac('/../secrets.txt')
      const result = await route.check(mockOdac)

      expect(mockOpen).not.toHaveBeenCalled()
      expect(result).toBeUndefined() // Falls through if blocked
    })

    it('should prevent null byte injection attacks', async () => {
      const mockOpen = jest.spyOn(fs.promises, 'open')

      const mockOdac = createMockOdac('/style%00.css')
      const result = await route.check(mockOdac)

      expect(mockOpen).not.toHaveBeenCalled()
      expect(result).toBeUndefined()
    })

    it('should handle invalid URI encoding gracefully', async () => {
      const mockOpen = jest.spyOn(fs.promises, 'open')

      const mockOdac = createMockOdac('/%E0%A4%A') // Invalid URL encoded string
      const result = await route.check(mockOdac)

      expect(mockOpen).not.toHaveBeenCalled()
      expect(result).toBeUndefined()
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
      route.routes = {www: {post: {'/submit': {cache: jest.fn()}}}}
      global.__dir = tmpDir

      const mockOdac = createMockOdac('post', '/submit')
      mockOdac.request = jest.fn(async key => (key === '_odac_form_token' ? 'tok123' : null))
      await route.check(mockOdac)

      // Form set-callbacks (Odac.fn) are user code and may read Odac.Auth.user().
      expect(mockOdac.Auth.check).toHaveBeenCalled()
    })

    // Reading the form token parses the body; an upload to a URL nothing handles must not be.
    it('does not read the body of a post to a URL without a route', async () => {
      route.routes = {www: {}}
      global.__dir = tmpDir

      const mockOdac = createMockOdac('post', '/nowhere')
      mockOdac.request = jest.fn(async () => null)
      await route.check(mockOdac)

      expect(mockOdac.request).not.toHaveBeenCalled()
      expect(mockOdac.Request.abort).toHaveBeenCalledWith(404)
    })

    it('reads the form token for a post to a page route', async () => {
      route.routes = {www: {page: {'/contact': {cache: jest.fn()}}}}
      global.__dir = tmpDir

      const mockOdac = createMockOdac('post', '/contact')
      mockOdac.request = jest.fn(async () => null)
      await route.check(mockOdac)

      expect(mockOdac.request).toHaveBeenCalledWith('_odac_form_token')
    })
  })

  describe('AJAX navigation headers', () => {
    const ajaxOdac = parts => ({
      Auth: {check: jest.fn().mockResolvedValue(true)},
      Config: {},
      Request: {
        url: '/x',
        method: 'get',
        route: 'www',
        header: jest.fn(key => ({'X-Odac': 'ajaxload', 'X-Odac-Load': 'content', 'X-Odac-Parts': parts})[key]),
        cookie: jest.fn(() => null),
        abort: jest.fn(),
        setSession: jest.fn(),
        data: {url: {}}
      },
      request: jest.fn().mockResolvedValue(null)
    })

    it('ignores a malformed escape in X-Odac-Parts instead of failing the request', async () => {
      route.routes = {www: {page: {'/x': {cache: jest.fn(() => 'ok')}}}}
      const odac = ajaxOdac('header=%E0%A4%A,content=pages%2Fx')
      await route.check(odac)
      expect(odac.Request.clientParts.content).toBe('pages/x')
      expect(odac.Request.clientParts.header).toBeUndefined()
    })

    it('keeps __proto__ in X-Odac-Parts an ordinary key', async () => {
      route.routes = {www: {page: {'/x': {cache: jest.fn(() => 'ok')}}}}
      const odac = ajaxOdac('__proto__=x,content=y')
      await route.check(odac)
      expect(Object.getPrototypeOf(odac.Request.clientParts)).toBeNull()
      expect(odac.Request.clientParts.__proto__).toBe('x')
      expect({}.content).toBeUndefined()
    })
  })
})
