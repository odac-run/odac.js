const EarlyHints = require('../../../src/View/EarlyHints')

describe('EarlyHints.formatLinkHeader()', () => {
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

  it('should format basic resource', () => {
    const resource = {href: '/css/main.css', as: 'style'}
    const header = earlyHints.formatLinkHeader(resource)
    expect(header).toBe('</css/main.css>; rel=preload; as=style')
  })

  it('should format resource with crossorigin', () => {
    const resource = {href: '/font.woff2', as: 'font', crossorigin: 'anonymous'}
    const header = earlyHints.formatLinkHeader(resource)
    expect(header).toBe('</font.woff2>; rel=preload; as=font; crossorigin')
  })

  it('should format resource with type', () => {
    const resource = {href: '/data.json', as: 'fetch', type: 'application/json'}
    const header = earlyHints.formatLinkHeader(resource)
    expect(header).toBe('</data.json>; rel=preload; as=fetch; type=application/json')
  })
})
