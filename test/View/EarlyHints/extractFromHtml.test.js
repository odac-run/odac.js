const EarlyHints = require('../../../src/View/EarlyHints')

describe('EarlyHints.extractFromHtml()', () => {
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

  it('should extract CSS resources from head', () => {
    const html = `
      <html>
        <head>
          <link rel="stylesheet" href="/css/main.css">
          <link rel="stylesheet" href="/css/theme.css">
        </head>
        <body></body>
      </html>
    `
    const resources = earlyHints.extractFromHtml(html)
    expect(resources).toHaveLength(2)
    expect(resources[0]).toEqual({href: '/css/main.css', as: 'style'})
    expect(resources[1]).toEqual({href: '/css/theme.css', as: 'style'})
  })

  it('should extract JS resources from head', () => {
    const html = `
      <html>
        <head>
          <script src="/js/app.js"></script>
        </head>
        <body></body>
      </html>
    `
    const resources = earlyHints.extractFromHtml(html)
    expect(resources).toHaveLength(1)
    expect(resources[0]).toEqual({href: '/js/app.js', as: 'script'})
  })

  it('should not extract deferred JS', () => {
    const html = `
      <html>
        <head>
          <script src="/js/app.js" defer></script>
          <script src="/js/async.js" async></script>
        </head>
        <body></body>
      </html>
    `
    const resources = earlyHints.extractFromHtml(html)
    expect(resources).toHaveLength(0)
  })

  it('should extract font resources', () => {
    const html = `
      <html>
        <head>
          <link rel="preload" href="/fonts/main.woff2" as="font">
        </head>
        <body></body>
      </html>
    `
    const resources = earlyHints.extractFromHtml(html)
    expect(resources).toHaveLength(1)
    expect(resources[0]).toEqual({
      href: '/fonts/main.woff2',
      as: 'font',
      crossorigin: 'anonymous'
    })
  })

  it('should limit resources to maxResources', () => {
    const html = `
      <html>
        <head>
          <link rel="stylesheet" href="/css/1.css">
          <link rel="stylesheet" href="/css/2.css">
          <link rel="stylesheet" href="/css/3.css">
          <link rel="stylesheet" href="/css/4.css">
          <link rel="stylesheet" href="/css/5.css">
          <link rel="stylesheet" href="/css/6.css">
        </head>
        <body></body>
      </html>
    `
    const resources = earlyHints.extractFromHtml(html)
    expect(resources).toHaveLength(5)
  })

  it('should return empty array when no head tag', () => {
    const html = '<html><body></body></html>'
    const resources = earlyHints.extractFromHtml(html)
    expect(resources).toEqual([])
  })

  it('should return empty array when disabled', () => {
    const hints = new EarlyHints({enabled: false})
    const html = '<html><head><link rel="stylesheet" href="/css/main.css"></head></html>'
    const resources = hints.extractFromHtml(html)
    expect(resources).toEqual([])
  })

  it('should skip resources with defer attribute', () => {
    const html = `
      <html>
        <head>
          <link rel="stylesheet" href="/css/critical.css">
          <link rel="stylesheet" href="/css/non-critical.css" defer>
          <script src="/js/app.js"></script>
          <script src="/js/analytics.js" defer></script>
        </head>
        <body></body>
      </html>
    `
    const resources = earlyHints.extractFromHtml(html)
    expect(resources).toHaveLength(2)
    expect(resources[0]).toEqual({href: '/css/critical.css', as: 'style'})
    expect(resources[1]).toEqual({href: '/js/app.js', as: 'script'})
  })

  it('should only detect stylesheets with rel="stylesheet"', () => {
    const html = `
      <html>
        <head>
          <link rel="stylesheet" href="/css/main.css">
          <link rel="icon" href="/favicon.css">
          <link rel="preload" href="/data.css" as="fetch">
          <link href="/other.css">
        </head>
        <body></body>
      </html>
    `
    const resources = earlyHints.extractFromHtml(html)
    expect(resources).toHaveLength(1)
    expect(resources[0]).toEqual({href: '/css/main.css', as: 'style'})
  })
})
