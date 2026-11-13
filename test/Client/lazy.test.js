// Lazy components: `<odac-lazy>` placeholders load from /_odac/lazy when they come near the
// viewport (or at once with data-odac-when="load") and are replaced by the rendered component.

describe('odac.js lazy components', () => {
  let xhrs, placeholders, observer, events, markers

  const placeholder = (token, when = null) => {
    const element = {
      attributes: {'data-odac-lazy': token, ...(when ? {'data-odac-when': when} : {})},
      isConnected: true,
      getAttribute: name => element.attributes[name] ?? null,
      setAttribute: (name, value) => {
        element.attributes[name] = value
      },
      replaceWith: jest.fn(() => {
        element.isConnected = false
      })
    }
    placeholders.push(element)
    return element
  }

  const respond = (xhr, body, status = 200) => {
    xhr.status = status
    xhr.responseText = JSON.stringify(body)
    xhr.onload()
  }

  const lazyRequests = () => xhrs.filter(xhr => xhr.url?.startsWith('/_odac/lazy'))

  const boot = ({intersection = true} = {}) => {
    jest.resetModules()
    const XMLHttpRequest = jest.fn(function () {
      const xhr = {
        open: jest.fn((method, url) => Object.assign(xhr, {method, url})),
        setRequestHeader: jest.fn(),
        send: jest.fn(),
        getResponseHeader: jest.fn(() => 'application/json'),
        status: 200,
        responseText: '{}'
      }
      xhrs.push(xhr)
      return xhr
    })
    global.document = {
      getElementById: jest.fn(() => null),
      querySelectorAll: jest.fn(selector =>
        selector === 'odac-lazy[data-odac-lazy]:not([data-odac-lazy-state])'
          ? placeholders.filter(element => element.isConnected && element.getAttribute('data-odac-lazy-state') === null)
          : []
      ),
      querySelector: jest.fn(selector => markers[selector.match(/data-odac-stack="([^"]+)"/)?.[1]] ?? null),
      createElement: jest.fn(tag => {
        if (tag !== 'template') return {nodeName: tag.toUpperCase(), setAttribute: jest.fn(), textContent: ''}
        const holder = {content: {childNodes: []}}
        Object.defineProperty(holder, 'innerHTML', {
          set: html => {
            holder.content.childNodes = html.startsWith('<script')
              ? [{nodeName: 'SCRIPT', attributes: [{name: 'src', value: '/x.js'}], textContent: ''}]
              : [{nodeName: 'SECTION', html}]
          }
        })
        return holder
      }),
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
      dispatchEvent: jest.fn(event => events.push(event)),
      documentElement: {dataset: {}},
      cookie: '',
      readyState: 'complete',
      title: ''
    }
    global.window = {location: {href: 'https://site.com/'}, history: {pushState: jest.fn()}, addEventListener: jest.fn(), XMLHttpRequest}
    global.window.window = global.window
    global.XMLHttpRequest = XMLHttpRequest
    global.CustomEvent = jest.fn((name, init) => ({name, detail: init?.detail}))
    global.localStorage = {getItem: jest.fn(), setItem: jest.fn(), removeItem: jest.fn()}
    if (intersection) {
      global.IntersectionObserver = jest.fn(function (callback, options) {
        observer = {callback, options, observe: jest.fn(), unobserve: jest.fn()}
        return observer
      })
    }
    require('../../client/odac.js')
  }

  beforeEach(() => {
    xhrs = []
    placeholders = []
    events = []
    markers = {}
    observer = null
  })

  afterEach(() => {
    for (const key of [
      'window',
      'document',
      'XMLHttpRequest',
      'CustomEvent',
      'localStorage',
      'IntersectionObserver',
      'Odac',
      '__',
      '__x'
    ]) {
      delete global[key]
    }
  })

  it('loads data-odac-when="load" placeholders at once, with the X-Odac: lazy header', () => {
    const element = placeholder('tok-1_A', 'load')
    boot()
    const [xhr] = lazyRequests()
    expect(xhr.method).toBe('GET')
    expect(xhr.url).toBe('/_odac/lazy?t=tok-1_A')
    expect(xhr.setRequestHeader).toHaveBeenCalledWith('X-Odac', 'lazy')
    expect(xhr.setRequestHeader).not.toHaveBeenCalledWith('Content-Type', expect.anything())
    expect(element.getAttribute('data-odac-lazy-state')).toBe('loading')
  })

  it('waits until a placeholder comes near the viewport', () => {
    const element = placeholder('tok')
    boot()
    expect(lazyRequests()).toHaveLength(0)
    expect(observer.options).toEqual({rootMargin: '200px'})
    expect(observer.observe).toHaveBeenCalledWith(element)

    observer.callback([{target: element, isIntersecting: false}])
    expect(lazyRequests()).toHaveLength(0)
    observer.callback([{target: element, isIntersecting: true}])
    expect(observer.unobserve).toHaveBeenCalledWith(element)
    expect(lazyRequests()).toHaveLength(1)
  })

  it('loads every placeholder at once without IntersectionObserver', () => {
    placeholder('a')
    placeholder('b')
    boot({intersection: false})
    expect(lazyRequests().map(xhr => xhr.url)).toEqual(['/_odac/lazy?t=a', '/_odac/lazy?t=b'])
  })

  it('replaces the placeholder with the component and announces it', () => {
    const element = placeholder('tok', 'load')
    boot()
    respond(lazyRequests()[0], {html: '<section>Post</section>', stacks: {}})
    const [content] = element.replaceWith.mock.calls[0]
    expect(content.childNodes).toEqual([{nodeName: 'SECTION', html: '<section>Post</section>'}])
    expect(events.find(event => event.name === 'odac:lazy').detail.nodes).toEqual([{nodeName: 'SECTION', html: '<section>Post</section>'}])
  })

  it('inserts pushed content at the stack markers and runs pushed scripts', () => {
    const inserted = []
    markers.scripts = {
      attributes: {'data-odac-keys': ''},
      getAttribute(name) {
        return this.attributes[name] ?? null
      },
      setAttribute(name, value) {
        this.attributes[name] = value
      },
      parentNode: {insertBefore: jest.fn(node => inserted.push(node))}
    }
    placeholder('tok', 'load')
    boot()
    respond(lazyRequests()[0], {html: '<section></section>', stacks: {scripts: [{key: 'k1', html: '<script src="/x.js"></script>'}]}})
    expect(inserted).toHaveLength(1)
    expect(inserted[0].nodeName).toBe('SCRIPT')
    expect(inserted[0].setAttribute).toHaveBeenCalledWith('src', '/x.js')
    expect(markers.scripts.attributes['data-odac-keys']).toBe('k1')
  })

  it('keeps the placeholder and marks it when the load fails', () => {
    const element = placeholder('tok', 'load')
    boot()
    respond(lazyRequests()[0], {}, 403)
    expect(element.replaceWith).not.toHaveBeenCalled()
    expect(element.getAttribute('data-odac-lazy-state')).toBe('error')
    expect(events.find(event => event.name === 'odac:lazyError').detail.element).toBe(element)
  })

  it('treats a response without html as a failure', () => {
    const element = placeholder('tok', 'load')
    boot()
    respond(lazyRequests()[0], {nope: true})
    expect(element.getAttribute('data-odac-lazy-state')).toBe('error')
  })

  it('ignores a response for a placeholder that navigation removed', () => {
    const element = placeholder('tok', 'load')
    boot()
    element.isConnected = false
    respond(lazyRequests()[0], {html: '<section></section>'})
    expect(element.replaceWith).not.toHaveBeenCalled()
    expect(events.filter(event => event.name.startsWith('odac:lazy'))).toHaveLength(0)
  })

  it('stops observing placeholders that left the page, and picks up new ones', () => {
    const first = placeholder('first', 'load')
    const removed = placeholder('removed')
    boot()
    removed.isConnected = false
    const nested = placeholder('nested', 'load')
    respond(lazyRequests()[0], {html: '<section></section>'})
    expect(first.replaceWith).toHaveBeenCalled()
    expect(observer.unobserve).toHaveBeenCalledWith(removed)
    expect(lazyRequests().map(xhr => xhr.url)).toEqual(['/_odac/lazy?t=first', '/_odac/lazy?t=nested'])
  })
})
