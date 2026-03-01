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
})
