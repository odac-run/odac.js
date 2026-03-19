const View = require('../../src/View')

describe('View.constructor()', () => {
  let mockOdac

  beforeEach(() => {
    mockOdac = {
      Config: {view: {earlyHints: {enabled: true}}},
      View: {}
    }
  })

  it('should initialize with EarlyHints if enabled', () => {
    const view = new View(mockOdac)
    expect(view).toBeDefined()
  })

  it('should set global.Odac.View.Form', () => {
    new View(mockOdac)
    expect(global.Odac.View.Form).toBeDefined()
  })

  it('should set global.Odac.View.Image', () => {
    new View(mockOdac)
    expect(global.Odac.View.Image).toBeDefined()
  })

  it('should expose Image on the instance for compiled templates', () => {
    const view = new View(mockOdac)
    expect(view.Image).toBe(global.Odac.View.Image)
  })
})
