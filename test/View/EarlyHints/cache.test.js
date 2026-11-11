const EarlyHints = require('../../../src/View/EarlyHints')

describe('EarlyHints Caching', () => {
  let earlyHints
  let mockConfig

  beforeEach(() => {
    mockConfig = {
      enabled: true,
      auto: true,
      maxResources: 5
    }
    earlyHints = new EarlyHints(mockConfig)
  })

  it('should cache hints for route', () => {
    const resources = [{href: '/css/main.css', as: 'style'}]
    earlyHints.cacheHints('/home', resources)

    const cached = earlyHints.getHints(null, '/home')
    expect(cached).toEqual(resources)
  })

  it('should not cache when disabled', () => {
    const hints = new EarlyHints({enabled: false})
    const resources = [{href: '/css/main.css', as: 'style'}]
    hints.cacheHints('/home', resources)

    const cached = hints.getHints(null, '/home')
    expect(cached).toBeNull()
  })
  it('bounds the cache and evicts the least recently used entry', () => {
    const hints = new EarlyHints({...mockConfig, maxCacheEntries: 2})
    const css = href => [{href, as: 'style'}]
    hints.cacheHints('a', css('/a.css'))
    hints.cacheHints('b', css('/b.css'))
    hints.getHints(null, 'a')
    hints.cacheHints('c', css('/c.css'))

    expect(hints.getHints(null, 'a')).toEqual(css('/a.css'))
    expect(hints.getHints(null, 'b')).toBeNull()
    expect(hints.getHints(null, 'c')).toEqual(css('/c.css'))
  })

  it('applies a default bound when maxCacheEntries is not configured', () => {
    const resources = [{href: '/css/main.css', as: 'style'}]
    for (let i = 0; i < 1500; i++) earlyHints.cacheHints(`key-${i}`, resources)

    expect(earlyHints.getHints(null, 'key-0')).toBeNull()
    expect(earlyHints.getHints(null, 'key-1499')).toEqual(resources)
  })
})
