const fs = require('fs')
const path = require('path')

describe('Client (odac.js)', () => {
  let mockXhr

  beforeEach(() => {
    jest.resetModules()

    mockXhr = {
      open: jest.fn(),
      setRequestHeader: jest.fn(),
      send: jest.fn(),
      getResponseHeader: jest.fn(),
      status: 200,
      responseText: '{}',
      response: '{}',
      onload: null,
      onerror: null
    }

    const mockDocument = {
      getElementById: jest.fn(),
      querySelectorAll: jest.fn(() => []),
      querySelector: jest.fn(),
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
      dispatchEvent: jest.fn(),
      documentElement: {dataset: {}},
      cookie: '',
      readyState: 'complete',
      createElement: jest.fn(() => ({
        setAttribute: jest.fn(),
        style: {},
        appendChild: jest.fn(),
        parentNode: {insertBefore: jest.fn()}
      }))
    }

    const mockWindow = {
      location: {
        protocol: 'http:',
        host: 'localhost',
        href: 'http://localhost/'
      },
      history: {
        pushState: jest.fn()
      },
      scrollTo: jest.fn(),
      addEventListener: jest.fn(),
      XMLHttpRequest: jest.fn(() => mockXhr),
      localStorage: {
        getItem: jest.fn(),
        setItem: jest.fn(),
        removeItem: jest.fn()
      },
      CustomEvent: jest.fn((name, detail) => ({name, detail})),
      setTimeout: jest.fn(),
      clearTimeout: jest.fn(),
      requestAnimationFrame: jest.fn(cb => cb(Date.now())),
      WebSocket: jest.fn(() => ({
        send: jest.fn(),
        close: jest.fn(),
        readyState: 1 // OPEN
      })),
      FormData: jest.fn()
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

    delete require.cache[require.resolve('../client/odac.js')]
    require('../client/odac.js')
  })

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

  test('Odac should be initialized on window', () => {
    expect(window.Odac).toBeDefined()
  })

  describe('data()', () => {
    test('should retrieve data from odac-data script tag', () => {
      const mockData = {user: 'emre'}
      document.getElementById.mockReturnValue({
        textContent: JSON.stringify(mockData)
      })

      const result = window.Odac.data()
      expect(result).toEqual(mockData)
      expect(document.getElementById).toHaveBeenCalledWith('odac-data')
    })

    test('should return specific key from data', () => {
      const mockData = {user: 'emre', role: 'admin'}
      document.getElementById.mockReturnValue({
        textContent: JSON.stringify(mockData)
      })

      expect(window.Odac.data('user')).toBe('emre')
      expect(window.Odac.data('role')).toBe('admin')
    })
  })

  describe('storage()', () => {
    test('should get item from localStorage', () => {
      localStorage.getItem.mockReturnValue('val')
      expect(window.Odac.storage('key')).toBe('val')
      expect(localStorage.getItem).toHaveBeenCalledWith('key')
    })

    test('should set item in localStorage', () => {
      window.Odac.storage('key', 'val')
      expect(localStorage.setItem).toHaveBeenCalledWith('key', 'val')
    })
  })

  describe('token()', () => {
    test('should fetch token via sync XHR if hash is empty', () => {
      mockXhr.response = JSON.stringify({token: 'new-token'})
      document.cookie = 'odac_client=abc'

      const token = window.Odac.token()

      expect(window.XMLHttpRequest).toHaveBeenCalled()
      expect(token).toBe('new-token')
    })
  })

  describe('OdacWebSocket', () => {
    test('should connect to WebSocket and handle events', () => {
      const ws = window.Odac.ws('/test-ws', {token: false})
      expect(window.WebSocket).toHaveBeenCalled()

      const openHandler = jest.fn()
      ws.on('open', openHandler)

      const socketInstance = WebSocket.mock.results[0].value
      socketInstance.onopen()

      expect(openHandler).toHaveBeenCalled()
    })
  })
})
