describe('Odac.load()', () => {
  let mockXhr, mockDocument, mockWindow

  const setupMocks = (options = {}) => {
    jest.resetModules()
    mockXhr = {
      open: jest.fn(),
      setRequestHeader: jest.fn(),
      send: jest.fn(),
      getResponseHeader: jest.fn(() => null),
      responseURL: '',
      status: 200,
      responseText: '{}',
      response: '{}',
      onload: null,
      onerror: null
    }

    const transitionElements = options.transitionElements || []

    mockDocument = {
      getElementById: jest.fn(),
      querySelectorAll: jest.fn(selector => {
        if (selector === '[odac-transition]') return transitionElements
        return []
      }),
      querySelector: jest.fn(),
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
      dispatchEvent: jest.fn(),
      documentElement: {dataset: {}},
      cookie: '',
      readyState: 'complete',
      startViewTransition: options.hasViewTransition
        ? jest.fn(cb => {
            cb()
            return {
              finished: Promise.resolve(),
              ready: Promise.resolve(),
              updateCallbackDone: Promise.resolve()
            }
          })
        : undefined,
      createElement: jest.fn(tag => {
        const el = {
          setAttribute: jest.fn(),
          style: {},
          appendChild: jest.fn(),
          parentNode: {insertBefore: jest.fn()},
          _innerHTML: '',
          get value() {
            if (tag === 'textarea') {
              return this._innerHTML
                .replace(/&amp;/g, '&')
                .replace(/&lt;/g, '<')
                .replace(/&gt;/g, '>')
                .replace(/&quot;/g, '"')
                .replace(/&#039;/g, "'")
            }
            return ''
          }
        }
        Object.defineProperty(el, 'innerHTML', {
          get() {
            return el._innerHTML
          },
          set(v) {
            el._innerHTML = v
          }
        })
        return el
      })
    }

    mockWindow = {
      location: {protocol: 'http:', host: 'localhost', href: 'http://localhost/', replace: jest.fn()},
      history: {pushState: jest.fn()},
      scrollTo: jest.fn(),
      addEventListener: jest.fn(),
      XMLHttpRequest: jest.fn(() => mockXhr),
      localStorage: {getItem: jest.fn(), setItem: jest.fn(), removeItem: jest.fn()},
      CustomEvent: jest.fn((name, detail) => ({name, detail})),
      setTimeout: jest.fn(),
      clearTimeout: jest.fn(),
      requestAnimationFrame: jest.fn(cb => cb(Date.now())),
      WebSocket: jest.fn(() => ({send: jest.fn(), close: jest.fn(), readyState: 1})),
      FormData: jest.fn(),
      URL: global.URL
    }
    mockWindow.window = mockWindow
    mockWindow.document = mockDocument
    mockWindow.WebSocket.OPEN = 1
    mockWindow.WebSocket.CLOSED = 3
    global.window = mockWindow
    global.document = mockDocument
    global.location = mockWindow.location
    global.XMLHttpRequest = mockWindow.XMLHttpRequest
    global.localStorage = mockWindow.localStorage
    global.CustomEvent = mockWindow.CustomEvent
    global.WebSocket = mockWindow.WebSocket
    global.setTimeout = mockWindow.setTimeout
    global.clearTimeout = mockWindow.clearTimeout
    global.requestAnimationFrame = mockWindow.requestAnimationFrame
    global.FormData = mockWindow.FormData
    delete require.cache[require.resolve('../../client/odac.js')]
    require('../../client/odac.js')
  }

  afterEach(() => {
    delete global.window
    delete global.document
    delete global.location
    delete global.XMLHttpRequest
    delete global.localStorage
    delete global.CustomEvent
    delete global.WebSocket
    delete global.setTimeout
    delete global.clearTimeout
    delete global.requestAnimationFrame
    delete global.FormData
    delete global.Odac
  })

  describe('URL validation', () => {
    beforeEach(() => setupMocks())

    test('should resolve empty string to current URL and proceed with navigation', () => {
      jest.spyOn(window.Odac, 'token').mockReturnValue('mock-token')
      window.Odac.load('', jest.fn())
      // Empty string resolves to current URL via new URL('', base) — AJAX fires normally
      expect(mockXhr.send).toHaveBeenCalled()
    })

    test('should reject javascript: protocol URLs', () => {
      const result = window.Odac.load('javascript:void(0)', jest.fn())
      expect(result).toBe(false)
    })

    test('should reject data: protocol URLs', () => {
      const result = window.Odac.load('data:text/html,test', jest.fn())
      expect(result).toBe(false)
    })

    test('should reject vbscript: protocol URLs', () => {
      const result = window.Odac.load('vbscript:test', jest.fn())
      expect(result).toBe(false)
    })

    test('should reject hash-only URLs', () => {
      const result = window.Odac.load('#section', jest.fn())
      expect(result).toBe(false)
    })

    test('should prevent concurrent navigations', () => {
      window.Odac.load('/page-1', jest.fn())
      const result = window.Odac.load('/page-2', jest.fn())
      expect(result).toBe(false)
    })
  })

  describe('fade fallback path', () => {
    beforeEach(() => setupMocks({hasViewTransition: false}))

    test('should use fade when View Transition API is unavailable', () => {
      jest.spyOn(window.Odac, 'token').mockReturnValue('mock-token')
      window.Odac.load('/test', jest.fn())
      expect(mockXhr.open).toHaveBeenCalledWith('GET', 'http://localhost/test', true)
      expect(mockXhr.send).toHaveBeenCalled()
    })

    test('should fallback to window.location.replace on AJAX error', () => {
      jest.spyOn(window.Odac, 'token').mockReturnValue('mock-token')
      window.Odac.load('/error-page', jest.fn())
      mockXhr.onerror()
      expect(mockWindow.location.replace).toHaveBeenCalledWith('http://localhost/error-page')
    })
  })

  describe('View Transition API path', () => {
    let transitionElements

    beforeEach(() => {
      transitionElements = [
        {getAttribute: jest.fn(() => 'header'), style: {}, setAttribute: jest.fn()},
        {getAttribute: jest.fn(() => 'hero'), style: {}, setAttribute: jest.fn()}
      ]
      setupMocks({hasViewTransition: true, transitionElements})
    })

    test('should use View Transition API when supported and odac-transition elements exist', () => {
      jest.spyOn(window.Odac, 'token').mockReturnValue('mock-token')
      window.Odac.load('/new-page', jest.fn())

      expect(transitionElements[0].style.viewTransitionName).toBe('header')
      expect(transitionElements[1].style.viewTransitionName).toBe('hero')
      expect(mockXhr.send).toHaveBeenCalled()
    })

    test('should call startViewTransition on successful AJAX response', () => {
      jest.spyOn(window.Odac, 'token').mockReturnValue('mock-token')
      mockXhr.responseURL = 'http://localhost/new-page'
      mockXhr.getResponseHeader.mockImplementation(h => (h === 'Content-Type' ? 'application/json' : null))

      window.Odac.load('/new-page', jest.fn())

      mockXhr.responseText = JSON.stringify({title: 'New Page', output: {}})
      mockXhr.status = 200
      if (mockXhr.onload) mockXhr.onload()

      expect(mockDocument.startViewTransition).toHaveBeenCalled()
    })

    test('should apply transition names to elements before snapshot', () => {
      jest.spyOn(window.Odac, 'token').mockReturnValue('mock-token')
      window.Odac.load('/page', jest.fn())

      expect(transitionElements[0].getAttribute).toHaveBeenCalledWith('odac-transition')
      expect(transitionElements[0].style.viewTransitionName).toBe('header')
      expect(transitionElements[1].getAttribute).toHaveBeenCalledWith('odac-transition')
      expect(transitionElements[1].style.viewTransitionName).toBe('hero')
    })

    test('should fall back to full page load on skeleton change', () => {
      jest.spyOn(window.Odac, 'token').mockReturnValue('mock-token')
      mockXhr.responseURL = 'http://localhost/new-skeleton'
      mockXhr.getResponseHeader.mockImplementation(h => (h === 'Content-Type' ? 'application/json' : null))

      window.Odac.load('/new-skeleton', jest.fn())

      mockXhr.responseText = JSON.stringify({skeletonChanged: true})
      mockXhr.status = 200
      if (mockXhr.onload) mockXhr.onload()

      expect(mockDocument.startViewTransition).not.toHaveBeenCalled()
      expect(mockWindow.location.href).toBe('http://localhost/new-skeleton')
    })

    test('should clean transition names on AJAX error', () => {
      jest.spyOn(window.Odac, 'token').mockReturnValue('mock-token')
      window.Odac.load('/fail', jest.fn())

      mockXhr.onerror()

      expect(transitionElements[0].style.viewTransitionName).toBe('')
      expect(transitionElements[1].style.viewTransitionName).toBe('')
    })
  })

  describe('fade fallback when no odac-transition elements', () => {
    beforeEach(() => setupMocks({hasViewTransition: true, transitionElements: []}))

    test('should use fade path when API exists but no odac-transition elements found', () => {
      jest.spyOn(window.Odac, 'token').mockReturnValue('mock-token')
      window.Odac.load('/page', jest.fn())

      expect(mockDocument.startViewTransition).not.toHaveBeenCalled()
      expect(mockXhr.send).toHaveBeenCalled()
    })
  })

  describe('title HTML entity decoding', () => {
    beforeEach(() => setupMocks({hasViewTransition: false}))

    test('should decode HTML entities in title during fade navigation', () => {
      jest.spyOn(window.Odac, 'token').mockReturnValue('mock-token')
      mockXhr.responseURL = 'http://localhost/products'
      mockXhr.getResponseHeader.mockImplementation(h => (h === 'Content-Type' ? 'application/json' : null))

      window.Odac.load('/products', jest.fn())

      mockXhr.responseText = JSON.stringify({title: 'Tom &amp; Jerry', output: {}})
      mockXhr.status = 200
      mockXhr.onload()

      expect(mockDocument.title).toBe('Tom & Jerry')
    })

    test('should decode multiple HTML entities in title', () => {
      jest.spyOn(window.Odac, 'token').mockReturnValue('mock-token')
      mockXhr.responseURL = 'http://localhost/page'
      mockXhr.getResponseHeader.mockImplementation(h => (h === 'Content-Type' ? 'application/json' : null))

      window.Odac.load('/page', jest.fn())

      mockXhr.responseText = JSON.stringify({title: '&lt;ODAC&gt; &amp; &quot;Framework&quot;', output: {}})
      mockXhr.status = 200
      mockXhr.onload()

      expect(mockDocument.title).toBe('<ODAC> & "Framework"')
    })

    test('should handle title without entities unchanged', () => {
      jest.spyOn(window.Odac, 'token').mockReturnValue('mock-token')
      mockXhr.responseURL = 'http://localhost/simple'
      mockXhr.getResponseHeader.mockImplementation(h => (h === 'Content-Type' ? 'application/json' : null))

      window.Odac.load('/simple', jest.fn())

      mockXhr.responseText = JSON.stringify({title: 'Simple Page Title', output: {}})
      mockXhr.status = 200
      mockXhr.onload()

      expect(mockDocument.title).toBe('Simple Page Title')
    })
  })
})
