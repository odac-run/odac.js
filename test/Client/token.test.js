describe('Odac.token()', () => {
  let mockXhr, mockDocument, mockWindow

  beforeEach(() => {
    jest.resetModules()
    mockXhr = {
      open: jest.fn(),
      setRequestHeader: jest.fn(),
      send: jest.fn(),
      getResponseHeader: jest.fn(),
      status: 200,
      responseText: '{}',
      response: JSON.stringify({token: 'new-token'}),
      onload: null,
      onerror: null
    }
    mockDocument = {
      getElementById: jest.fn(),
      querySelectorAll: jest.fn(() => []),
      querySelector: jest.fn(),
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
      dispatchEvent: jest.fn(),
      documentElement: {dataset: {}},
      cookie: 'odac_client=abc',
      readyState: 'complete',
      createElement: jest.fn(() => ({setAttribute: jest.fn(), style: {}, appendChild: jest.fn(), parentNode: {insertBefore: jest.fn()}}))
    }
    mockWindow = {
      location: {protocol: 'http:', host: 'localhost', href: 'http://localhost/'},
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
    delete require.cache[require.resolve('../../client/odac.js')]
    require('../../client/odac.js')
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

  test('should fetch token via sync XHR if hash is empty', () => {
    const token = window.Odac.token()
    expect(window.XMLHttpRequest).toHaveBeenCalled()
    expect(token).toBe('new-token')
  })
})
