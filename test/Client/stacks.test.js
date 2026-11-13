// AJAX navigation inserts the `stacks` a page pushed (`<odac:push>`) at the page's stack markers,
// once per key, and runs pushed scripts after the new content is in place.

describe('odac.js navigation stacks', () => {
  let xhrs, markers, inserted

  // A parsed node of pushed HTML: `<script ...>` or any other element.
  const parse = html =>
    html
      .split(/(?=<)/)
      .filter(part => !part.startsWith('</'))
      .map(part =>
        part.startsWith('<script')
          ? {nodeName: 'SCRIPT', attributes: [{name: 'src', value: part.match(/src="([^"]*)"/)?.[1] ?? ''}], textContent: ''}
          : {nodeName: part.match(/^<(\w+)/)[1].toUpperCase(), html: part}
      )

  const marker = (name, keys) => {
    const element = {
      attributes: {'data-odac-keys': keys},
      getAttribute: attribute => element.attributes[attribute] ?? null,
      setAttribute: (attribute, value) => {
        element.attributes[attribute] = value
      },
      parentNode: {insertBefore: jest.fn(node => inserted.push({stack: name, node}))}
    }
    markers[name] = element
    return element
  }

  const navigate = response => {
    const event = {
      target: {getAttribute: attribute => (attribute === 'href' ? '/next' : null), closest: () => event.target},
      ctrlKey: false,
      metaKey: false,
      preventDefault: jest.fn()
    }
    for (const [type, handler] of document.addEventListener.mock.calls) if (type === 'click') handler(event)
    const xhr = xhrs.at(-1)
    xhr.responseText = JSON.stringify({output: {}, parts: {}, ...response})
    xhr.responseURL = 'https://site.com/next'
    xhr.onload()
  }

  beforeEach(() => {
    jest.resetModules()
    xhrs = []
    markers = {}
    inserted = []
    const XMLHttpRequest = jest.fn(function () {
      const xhr = {
        open: jest.fn((method, url) => Object.assign(xhr, {method, url})),
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
      getElementById: jest.fn(() => null),
      querySelectorAll: jest.fn(() => []),
      querySelector: jest.fn(selector => {
        const name = selector.match(/^template\[data-odac-stack="([^"]+)"\]$/)?.[1]
        return (name && markers[name]) || null
      }),
      createElement: jest.fn(tag => {
        if (tag === 'template') {
          const holder = {content: {childNodes: []}}
          Object.defineProperty(holder, 'innerHTML', {set: html => (holder.content.childNodes = parse(html))})
          return holder
        }
        return {nodeName: tag.toUpperCase(), setAttribute: jest.fn(), textContent: ''}
      }),
      addEventListener: jest.fn(),
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

  it('inserts items the page does not have yet and records their keys', () => {
    const head = marker('head', 'k1')
    navigate({
      stacks: {
        head: [
          {key: 'k1', html: '<link href="/old.css">'},
          {key: 'k2', html: '<link href="/new.css">'}
        ]
      }
    })
    expect(inserted).toEqual([{stack: 'head', node: {nodeName: 'LINK', html: '<link href="/new.css">'}}])
    expect(head.getAttribute('data-odac-keys')).toBe('k1 k2')
  })

  it('recreates pushed scripts so they run, once', () => {
    marker('scripts', '')
    navigate({stacks: {scripts: [{key: 's1', html: '<script src="/chart.js"></script>'}]}})
    expect(inserted).toHaveLength(1)
    expect(inserted[0].node.nodeName).toBe('SCRIPT')
    expect(inserted[0].node.setAttribute).toHaveBeenCalledWith('src', '/chart.js')

    navigate({stacks: {scripts: [{key: 's1', html: '<script src="/chart.js"></script>'}]}})
    expect(inserted).toHaveLength(1)
  })

  it('ignores stacks without a marker, invalid names and malformed items', () => {
    marker('head', '')
    navigate({
      stacks: {missing: [{key: 'a', html: '<i></i>'}], 'x"]': [{key: 'b', html: '<i></i>'}], head: [null, {key: 1, html: '<i></i>'}]}
    })
    expect(inserted).toHaveLength(0)
    expect(document.querySelector).not.toHaveBeenCalledWith(expect.stringContaining('x"]'))
  })
})
