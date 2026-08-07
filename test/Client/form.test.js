// Odac.form() previously swallowed transport failures: `error` only logged, so
// a 5xx / dropped connection left the app's own busy state hanging forever.
// The handler now feeds the callback a server-shaped failure response.

describe('Odac.form()', () => {
  let mockXhr, mockDocument, mockWindow, submitHandlers

  const makeFormElement = () => {
    const formElement = {
      attributes: {method: 'post', action: '/contact'},
      getAttribute: jest.fn(name => formElement.attributes[name] ?? null),
      setAttribute: jest.fn((name, value) => (formElement.attributes[name] = value)),
      querySelector: jest.fn(() => null),
      querySelectorAll: jest.fn(() => []),
      matches: jest.fn(() => true),
      appendChild: jest.fn(),
      insertBefore: jest.fn()
    }
    return formElement
  }

  const submit = formElement => {
    const event = {target: {closest: jest.fn(() => formElement)}, preventDefault: jest.fn()}
    submitHandlers.forEach(handler => handler(event))
  }

  beforeEach(() => {
    jest.resetModules()
    submitHandlers = []
    mockXhr = {
      open: jest.fn(),
      setRequestHeader: jest.fn(),
      send: jest.fn(),
      getResponseHeader: jest.fn(),
      upload: {addEventListener: jest.fn()},
      status: 200,
      statusText: 'OK',
      responseText: '{}',
      onload: null,
      onerror: null,
      onloadend: null
    }
    mockDocument = {
      getElementById: jest.fn(),
      querySelectorAll: jest.fn(() => []),
      querySelector: jest.fn(),
      addEventListener: jest.fn((type, handler) => {
        if (type === 'submit') submitHandlers.push(handler)
      }),
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
    jest.spyOn(window.Odac, 'token').mockReturnValue('mock-token')
    jest.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    jest.restoreAllMocks()
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

  test('invokes the callback with a failure response when the request fails', () => {
    const callback = jest.fn()
    const formElement = makeFormElement()

    window.Odac.form('#contact', callback)
    submit(formElement)

    mockXhr.status = 500
    mockXhr.statusText = 'Internal Server Error'
    mockXhr.onload()

    expect(callback).toHaveBeenCalledTimes(1)
    const payload = callback.mock.calls[0][0]
    expect(payload.result.success).toBe(false)
    expect(payload.errors._odac_form).toBe('Request failed')
    expect(payload.status).toBe('Internal Server Error')
  })

  test('invokes the callback when the connection drops', () => {
    const callback = jest.fn()
    const formElement = makeFormElement()

    window.Odac.form('#contact', callback)
    submit(formElement)

    mockXhr.onerror()

    expect(callback).toHaveBeenCalledTimes(1)
    expect(callback.mock.calls[0][0].result.success).toBe(false)
  })

  test('does not redirect to a string callback on failure', () => {
    const formElement = makeFormElement()

    window.Odac.form('#contact', '/done')
    submit(formElement)

    mockXhr.status = 500
    mockXhr.onload()

    expect(window.location.href).toBe('http://localhost/')
  })

  test('passes result.data through to the callback on success', () => {
    const callback = jest.fn()
    const formElement = makeFormElement()

    window.Odac.form({form: '#contact', messages: false}, callback)
    submit(formElement)

    mockXhr.status = 200
    mockXhr.responseText = JSON.stringify({result: {success: true, message: 'ok', data: {avatar: 'a1b2.png'}}})
    mockXhr.getResponseHeader.mockImplementation(h => (h === 'Content-Type' ? 'application/json' : null))
    mockXhr.onload()

    expect(callback).toHaveBeenCalledTimes(1)
    expect(callback.mock.calls[0][0].result.data).toEqual({avatar: 'a1b2.png'})
  })
})
