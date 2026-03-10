describe('Odac.ws()', () => {
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
      response: '{}',
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
      cookie: '',
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

  test('should connect to WebSocket and handle events', () => {
    const ws = window.Odac.ws('/test-ws', {token: false})
    expect(window.WebSocket).toHaveBeenCalled()
    const openHandler = jest.fn()
    ws.on('open', openHandler)
    const socketInstance = WebSocket.mock.results[0].value
    socketInstance.onopen()
    expect(openHandler).toHaveBeenCalled()
  })

  test('should use fresh token on reconnect', () => {
    let tokenCounter = 0
    mockXhr.response = JSON.stringify({token: 'initial-token'})
    mockXhr.responseText = JSON.stringify({token: 'initial-token'})
    mockXhr.onload = null
    mockXhr.send = jest.fn(function () {
      tokenCounter++
      this.response = JSON.stringify({token: `token-${tokenCounter}`})
      this.responseText = this.response
      if (this.onload) this.onload()
    })
    mockDocument.cookie = 'odac_client=test-client'

    window.Odac.ws('/test-ws', {token: true, autoReconnect: true, reconnectDelay: 100})
    const firstCall = WebSocket.mock.calls[0]
    expect(firstCall[1]).toEqual(expect.arrayContaining([expect.stringMatching(/^odac-token-/)]))
    const firstToken = firstCall[1][0]

    const socketInstance = WebSocket.mock.results[0].value
    socketInstance.onopen()

    global.setTimeout = jest.fn(fn => fn())
    socketInstance.readyState = 3
    socketInstance.onclose({code: 1006})

    expect(WebSocket.mock.calls.length).toBeGreaterThan(1)
    const secondCall = WebSocket.mock.calls[1]
    expect(secondCall[1]).toEqual(expect.arrayContaining([expect.stringMatching(/^odac-token-/)]))
    const secondToken = secondCall[1][0]
    expect(secondToken).not.toBe(firstToken)
  })
})
