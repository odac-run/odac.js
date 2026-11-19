/**
 * odac.js dev reload: the debug-mode change stream and what the page does with each message.
 */
describe('odac.js dev reload', () => {
  let source, xhrs, parts, links, win

  const element = name => ({
    name,
    style: {},
    innerHTML: `old ${name}`,
    getAttribute: jest.fn(() => name),
    setAttribute: jest.fn()
  })

  const link = href => {
    const node = {
      href,
      getAttribute: jest.fn(() => node.href),
      setAttribute: jest.fn((attr, value) => (node[attr] = value)),
      addEventListener: jest.fn((event, fn) => (node[`on${event}`] = fn)),
      remove: jest.fn(),
      after: jest.fn(next => links.push(next)),
      cloneNode: jest.fn(() => link(node.href))
    }
    return node
  }

  const setup = ({dev = true, eventSource = true, navigate = ['header', 'content'], stylesheets = []} = {}) => {
    jest.resetModules()
    xhrs = []
    parts = Object.fromEntries(navigate.map(name => [name, element(name)]))
    links = stylesheets.map(link)
    source = null

    const document = {
      readyState: 'complete',
      documentElement: {dataset: dev ? {odacDev: '', odacParts: JSON.stringify({header: 'main', content: 'home'})} : {}},
      cookie: '',
      title: '',
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
      dispatchEvent: jest.fn(),
      getElementById: jest.fn(() => null),
      querySelector: jest.fn(selector => {
        const match = /data-odac-navigate="(\w+)"/.exec(selector)
        return match ? (parts[match[1]] ?? null) : null
      }),
      querySelectorAll: jest.fn(selector => {
        if (selector === '[data-odac-navigate]') return Object.values(parts)
        if (selector === 'link[rel="stylesheet"][href]') return [...links]
        return []
      }),
      createElement: jest.fn(() => ({setAttribute: jest.fn(), style: {}, appendChild: jest.fn()}))
    }

    let now = 0
    win = {
      document,
      location: {
        protocol: 'http:',
        host: 'localhost',
        origin: 'http://localhost',
        href: 'http://localhost/docs?page=2#intro',
        pathname: '/docs',
        search: '?page=2',
        reload: jest.fn(),
        replace: jest.fn()
      },
      history: {pushState: jest.fn()},
      scrollX: 0,
      scrollY: 640,
      scrollTo: jest.fn(),
      addEventListener: jest.fn(),
      localStorage: {getItem: jest.fn(), setItem: jest.fn(), removeItem: jest.fn()},
      XMLHttpRequest: jest.fn(() => {
        const xhr = {
          headers: {},
          open: jest.fn((method, url) => (xhr.url = url)),
          setRequestHeader: jest.fn((key, value) => (xhr.headers[key] = value)),
          send: jest.fn(),
          getResponseHeader: jest.fn(() => null),
          status: 200
        }
        xhrs.push(xhr)
        return xhr
      }),
      CustomEvent: jest.fn((name, detail) => ({name, detail})),
      requestAnimationFrame: jest.fn(cb => cb((now += 1000))),
      URL: global.URL
    }
    win.window = win

    if (eventSource) {
      win.EventSource = jest.fn(function (url) {
        this.url = url
        source = this
      })
    }

    for (const key of [
      'window',
      'document',
      'location',
      'XMLHttpRequest',
      'localStorage',
      'CustomEvent',
      'requestAnimationFrame',
      'EventSource'
    ]) {
      global[key] = key === 'window' ? win : win[key]
    }
    require('../../client/odac.js')
  }

  const respond = (xhr, body) => {
    xhr.responseText = JSON.stringify(body)
    xhr.onload()
  }

  const push = message => source.onmessage({data: JSON.stringify(message)})

  afterEach(() => {
    for (const key of [
      'window',
      'document',
      'location',
      'XMLHttpRequest',
      'localStorage',
      'CustomEvent',
      'requestAnimationFrame',
      'EventSource',
      'Odac'
    ]) {
      delete global[key]
    }
  })

  describe('connection', () => {
    it('listens to /_odac/dev on a page marked with data-odac-dev', () => {
      setup()
      expect(win.EventSource).toHaveBeenCalledWith('/_odac/dev')
    })

    it('does not connect on a page without the marker (production)', () => {
      setup({dev: false})
      expect(win.EventSource).not.toHaveBeenCalled()
    })

    it('does nothing where EventSource does not exist', () => {
      expect(() => setup({eventSource: false})).not.toThrow()
    })

    it('reloads once the stream comes back after a lost connection', () => {
      setup()
      source.onopen()
      expect(win.location.reload).not.toHaveBeenCalled()
      source.onerror()
      source.onopen()
      expect(win.location.reload).toHaveBeenCalledTimes(1)
    })

    it('ignores messages that are not JSON objects', () => {
      setup()
      source.onmessage({data: 'not json'})
      source.onmessage({data: '"text"'})
      expect(win.location.reload).not.toHaveBeenCalled()
      expect(xhrs).toHaveLength(0)
    })
  })

  describe('messages', () => {
    it('reloads the page for {reload: true}', () => {
      setup()
      push({reload: true, parts: '*'})
      expect(win.location.reload).toHaveBeenCalled()
      expect(xhrs).toHaveLength(0)
    })

    it('swaps a changed stylesheet beside the old one and drops the old one once loaded', () => {
      setup({stylesheets: ['/assets/css/app.css', '/assets/css/other.css', 'https://cdn.example/assets/css/app.css']})
      const [app, other, cdn] = links
      push({css: ['/assets/css/app.css']})

      expect(app.after).toHaveBeenCalledTimes(1)
      expect(other.after).not.toHaveBeenCalled()
      expect(cdn.after).not.toHaveBeenCalled()
      const next = app.after.mock.calls[0][0]
      expect(next.href).toMatch(/^\/assets\/css\/app\.css\?_odac_dev=\w+$/)
      expect(app.remove).not.toHaveBeenCalled()
      next.onload()
      expect(app.remove).toHaveBeenCalled()
      expect(xhrs).toHaveLength(0)
    })

    it('re-renders only the changed part, forcing it past the unchanged-part check', () => {
      setup()
      push({parts: ['header']})

      expect(xhrs).toHaveLength(1)
      const [xhr] = xhrs
      expect(xhr.url).toBe('http://localhost/docs?page=2')
      expect(xhr.headers['X-Odac']).toBe('ajaxload')
      expect(xhr.headers['X-Odac-Load']).toBe('header')
      expect(xhr.headers['X-Odac-Parts']).toBe('content=home')

      respond(xhr, {output: {header: 'new header'}, parts: {header: 'main', content: 'home'}})
      expect(parts.header.innerHTML).toBe('new header')
      expect(parts.content.innerHTML).toBe('old content')
      expect(win.history.pushState).not.toHaveBeenCalled()
      expect(win.scrollTo).toHaveBeenLastCalledWith(0, 640)
    })

    it('re-renders every part for parts "*"', () => {
      setup()
      push({parts: '*'})
      const [xhr] = xhrs
      expect(xhr.headers['X-Odac-Load']).toBe('header,content')
      expect(xhr.headers['X-Odac-Parts']).toBeUndefined()
    })

    it('re-renders every part when the changed part is not on the page', () => {
      setup()
      push({parts: ['sidebar']})
      expect(xhrs[0].headers['X-Odac-Load']).toBe('header,content')
    })

    it('reloads a page that has no navigable parts', () => {
      setup({navigate: []})
      push({parts: ['content']})
      expect(win.location.reload).toHaveBeenCalled()
      expect(xhrs).toHaveLength(0)
    })

    it('handles a stylesheet and parts in one message', () => {
      setup({stylesheets: ['/assets/css/app.css']})
      push({css: ['/assets/css/app.css'], parts: ['content']})
      expect(links[0].after).toHaveBeenCalled()
      expect(xhrs[0].headers['X-Odac-Load']).toBe('content')
    })
  })

  describe('during a navigation', () => {
    it('waits for the navigation, then refreshes the parts collected meanwhile', () => {
      setup()
      window.Odac.load('/about')
      push({parts: ['header']})
      push({parts: ['content']})
      expect(xhrs).toHaveLength(1)

      respond(xhrs[0], {output: {header: 'h', content: 'about'}, parts: {header: 'main', content: 'about'}})
      // A normal navigation still goes to the top of the page.
      expect(win.scrollTo).toHaveBeenCalledWith({top: 0, behavior: 'smooth'})
      expect(xhrs).toHaveLength(2)
      expect(xhrs[1].headers['X-Odac-Load']).toBe('header,content')
      expect(xhrs[1].headers['X-Odac-Parts']).toBeUndefined()
    })

    it('keeps "every part" once any queued message asked for it', () => {
      setup()
      window.Odac.load('/about')
      push({parts: '*'})
      push({parts: ['header']})
      respond(xhrs[0], {output: {}, parts: {header: 'main', content: 'about'}})
      expect(xhrs[1].headers['X-Odac-Load']).toBe('header,content')
    })

    it('does not keep the scroll position for the navigation after a refresh', () => {
      setup()
      push({parts: ['content']})
      respond(xhrs[0], {output: {content: 'c'}, parts: {header: 'main', content: 'home'}})
      expect(win.scrollTo).toHaveBeenLastCalledWith(0, 640)

      window.Odac.load('/about')
      respond(xhrs[1], {output: {content: 'about'}, parts: {header: 'main', content: 'about'}})
      expect(win.scrollTo).toHaveBeenLastCalledWith({top: 0, behavior: 'smooth'})
    })

    it('falls back to a full load when the refresh request fails', () => {
      setup()
      push({parts: ['content']})
      xhrs[0].status = 500
      xhrs[0].onload()
      expect(win.location.replace).toHaveBeenCalledWith('http://localhost/docs?page=2')
    })
  })
})
