// Link interception compares origins (not substrings), hash links work, and built-in token
// callers never block on a synchronous request.

describe('odac.js navigation and tokens', () => {
  let xhrs, clickHandlers, elementsById

  const anchor = (href, target = null) => ({
    getAttribute: name => (name === 'href' ? href : name === 'target' ? target : null),
    closest() {
      return this
    }
  })

  const click = href => {
    const link = anchor(href)
    const event = {target: link, ctrlKey: false, metaKey: false, preventDefault: jest.fn()}
    for (const handler of clickHandlers) handler(event)
    return event
  }

  beforeEach(() => {
    jest.resetModules()
    xhrs = []
    clickHandlers = []
    elementsById = {}
    const XMLHttpRequest = jest.fn(function () {
      const xhr = {
        open: jest.fn((method, url, async) => Object.assign(xhr, {method, url, async})),
        setRequestHeader: jest.fn(),
        send: jest.fn(),
        getResponseHeader: jest.fn(() => 'application/json'),
        status: 200,
        responseText: '{}',
        response: '{}',
        responseURL: ''
      }
      xhrs.push(xhr)
      return xhr
    })
    const location = {
      protocol: 'https:',
      host: 'site.com',
      origin: 'https://site.com',
      href: 'https://site.com/docs',
      hash: '',
      assign: jest.fn()
    }
    global.document = {
      getElementById: jest.fn(id => elementsById[id] ?? null),
      querySelectorAll: jest.fn(() => []),
      querySelector: jest.fn(() => null),
      addEventListener: jest.fn((event, handler) => {
        if (event === 'click') clickHandlers.push(handler)
      }),
      removeEventListener: jest.fn(),
      dispatchEvent: jest.fn(),
      documentElement: {dataset: {}},
      cookie: 'odac_client=abc',
      readyState: 'complete',
      title: ''
    }
    global.window = {
      location,
      history: {pushState: jest.fn()},
      scrollTo: jest.fn(),
      addEventListener: jest.fn(),
      XMLHttpRequest,
      document: global.document
    }
    global.window.window = global.window
    global.location = location
    global.XMLHttpRequest = XMLHttpRequest
    global.CustomEvent = jest.fn((name, detail) => ({name, detail}))
    global.localStorage = {getItem: jest.fn(), setItem: jest.fn(), removeItem: jest.fn()}
    require('../../client/odac.js')
    window.Odac.loader('a[href^="/"]', {}, null)
  })

  afterEach(() => {
    for (const key of ['window', 'document', 'location', 'XMLHttpRequest', 'CustomEvent', 'localStorage', 'Odac']) delete global[key]
  })

  const ajaxLoads = () =>
    xhrs.filter(xhr => xhr.setRequestHeader.mock.calls.some(([name, value]) => name === 'X-Odac' && value === 'ajaxload'))

  it('leaves protocol-relative and look-alike external links to the browser', () => {
    for (const href of ['//evil.example/x', 'https://evil.example/?site.com', 'https://site.com.evil.example/']) {
      expect(click(href).preventDefault).not.toHaveBeenCalled()
    }
    expect(ajaxLoads()).toHaveLength(0)
  })

  it('navigates same-origin links in place', () => {
    expect(click('/about').preventDefault).toHaveBeenCalled()
    expect(ajaxLoads()[0].url).toBe('https://site.com/about')
  })

  it('leaves an anchor on the current page to the browser', () => {
    expect(click('/docs#install').preventDefault).not.toHaveBeenCalled()
    expect(ajaxLoads()).toHaveLength(0)
  })

  it('loads another page for a hash link, keeps the hash and scrolls to it', () => {
    const section = {scrollIntoView: jest.fn()}
    elementsById.usage = section
    expect(click('/guide#usage').preventDefault).toHaveBeenCalled()

    const xhr = ajaxLoads()[0]
    expect(xhr.url).toBe('https://site.com/guide')
    xhr.responseText = JSON.stringify({output: {}, parts: {}})
    xhr.responseURL = 'https://site.com/guide'
    xhr.onload()

    expect(window.history.pushState).toHaveBeenCalledWith(null, '', 'https://site.com/guide#usage')
    expect(section.scrollIntoView).toHaveBeenCalled()
    expect(window.scrollTo).not.toHaveBeenCalled()
  })

  it('hands a cross-origin load() to the browser instead of fetching it', () => {
    expect(window.Odac.load('https://evil.example/page')).toBe(false)
    expect(window.location.assign).toHaveBeenCalledWith('https://evil.example/page')
    expect(ajaxLoads()).toHaveLength(0)
  })

  it('fetches tokens asynchronously for tokenAsync()', async () => {
    const pending = window.Odac.tokenAsync()
    const request = xhrs.at(-1)
    expect(request.async).toBe(true)
    request.responseText = JSON.stringify({token: 't1'})
    request.onload()
    await expect(pending).resolves.toBe('t1')
    expect(xhrs.every(xhr => xhr.async !== false)).toBe(true)
  })

  it('does not throw from token() when the response is not JSON', () => {
    XMLHttpRequest.mockImplementationOnce(function () {
      return {open: jest.fn(), setRequestHeader: jest.fn(), send: jest.fn(), response: '<html>expired</html>'}
    })
    expect(() => window.Odac.token()).not.toThrow()
  })
})
