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

  describe('translations', () => {
    const serve = payload => (elementsById['odac-lang'] = {textContent: JSON.stringify(payload)})

    it('translates with the translations sent for the page', () => {
      serve({lang: 'tr', t: {Hello: 'Merhaba %s1', Items: '%s öğe', Gül: {'': 'Gül', verb: 'Gülümse'}}})
      expect(window.Odac.lang()).toBe('tr')
      expect(window.Odac.__('Hello', 'Emre')).toBe('Merhaba Emre')
      expect(window.Odac.__('Items', 3)).toBe('3 öğe')
      expect(window.Odac.__x('Gül', ' verb ')).toBe('Gülümse')
      expect(window.Odac.__('Gül')).toBe('Gül')
    })

    it('provides __() and __x() as globals', () => {
      serve({lang: 'tr', t: {Hello: 'Merhaba %s', Gül: {verb: 'Gülümse'}}})
      expect(window.__('Hello', 'Emre')).toBe('Merhaba Emre')
      expect(window.__x('Gül', 'verb')).toBe('Gülümse')
    })

    it('keeps a __ another script defined and warns', () => {
      jest.resetModules()
      const other = jest.fn()
      window.__ = other
      delete window.__x
      jest.spyOn(console, 'warn').mockImplementation(() => {})
      require('../../client/odac.js')
      expect(window.__).toBe(other)
      expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('window.__ is already defined'))
      expect(window.__x('Plain')).toBe('Plain')
      console.warn.mockRestore()
    })

    it('replaces its own globals when loaded again, without warning', () => {
      jest.resetModules()
      jest.spyOn(console, 'warn').mockImplementation(() => {})
      require('../../client/odac.js')
      expect(console.warn).not.toHaveBeenCalled()
      serve({lang: 'tr', t: {Hello: 'Merhaba'}})
      expect(window.__('Hello')).toBe('Merhaba')
      console.warn.mockRestore()
    })

    it('returns the key for anything it has no translation for', () => {
      serve({lang: 'tr', t: {Gül: {verb: 'Gülümse'}, Plain: 'Düz'}})
      expect(window.Odac.__('Missing %s', 'x')).toBe('Missing x')
      expect(window.Odac.__x('Gül', 'flower')).toBe('Gül')
      expect(window.Odac.__x('Plain', 'verb')).toBe('Plain')
      expect(window.Odac.__('constructor')).toBe('constructor')
      expect(window.Odac.__('toString')).toBe('toString')
      expect(window.Odac.__(42)).toBe(42)
    })

    it('inserts placeholder values literally', () => {
      serve({lang: 'en', t: {Pair: '%s1 / %s2'}})
      expect(window.Odac.__('Pair', '%s2', '$&')).toBe('%s2 / $&')
    })

    it('works without translations and ignores a malformed payload', () => {
      expect(window.Odac.lang()).toBeNull()
      expect(window.Odac.__('Hello')).toBe('Hello')
      jest.resetModules()
      jest.spyOn(console, 'error').mockImplementation(() => {})
      elementsById['odac-lang'] = {textContent: '{nope'}
      require('../../client/odac.js')
      expect(window.Odac.__('Hello')).toBe('Hello')
      console.error.mockRestore()
    })

    it('reports the translations it holds on navigation and takes new ones', () => {
      serve({lang: 'en', v: 'abc123', t: {Hello: 'Hello'}})
      click('/about')
      const xhr = ajaxLoads()[0]
      expect(xhr.setRequestHeader).toHaveBeenCalledWith('X-Odac-Lang', 'en:abc123')
      xhr.responseText = JSON.stringify({output: {}, parts: {}, lang: {lang: 'tr', t: {Hello: 'Merhaba'}}})
      xhr.responseURL = 'https://site.com/about'
      xhr.onload()
      expect(window.Odac.lang()).toBe('tr')
      expect(window.Odac.__('Hello')).toBe('Merhaba')
    })

    it('reports only the language for translations without a version', () => {
      serve({lang: 'en', t: {Hello: 'Hello'}})
      click('/about')
      expect(ajaxLoads()[0].setRequestHeader).toHaveBeenCalledWith('X-Odac-Lang', 'en')
    })

    it('reports nothing when the page has no translations', () => {
      click('/about')
      expect(ajaxLoads()[0].setRequestHeader).toHaveBeenCalledWith('X-Odac-Lang', '')
    })

    it('keeps its translations when a navigation response carries none', () => {
      serve({lang: 'en', t: {Hello: 'Hi'}})
      click('/about')
      const xhr = ajaxLoads()[0]
      xhr.responseText = JSON.stringify({output: {}, parts: {}, lang: 'bogus'})
      xhr.responseURL = 'https://site.com/about'
      xhr.onload()
      expect(window.Odac.__('Hello')).toBe('Hi')
    })
  })

  describe('document language', () => {
    const navigate = payload => {
      click('/about')
      const xhr = ajaxLoads()[0]
      xhr.responseText = JSON.stringify({output: {}, parts: {}, ...payload})
      xhr.responseURL = 'https://site.com/about'
      xhr.onload()
    }

    it('applies the served language and direction to <html>', () => {
      navigate({document: {lang: 'ar', dir: 'rtl'}})
      expect(document.documentElement.lang).toBe('ar')
      expect(document.documentElement.dir).toBe('rtl')
    })

    it('resets the direction when the next language is written left to right', () => {
      Object.assign(document.documentElement, {lang: 'ar', dir: 'rtl'})
      navigate({document: {lang: 'tr', dir: 'ltr'}})
      expect(document.documentElement.lang).toBe('tr')
      expect(document.documentElement.dir).toBe('ltr')
    })

    it('leaves <html> alone when the response declares no language or a malformed one', () => {
      Object.assign(document.documentElement, {lang: 'tr', dir: 'ltr'})
      navigate({})
      navigate({document: {lang: 'tr" onload="x', dir: 'rtl'}})
      expect(document.documentElement.lang).toBe('tr')
      expect(document.documentElement.dir).toBe('ltr')
    })
  })
})
