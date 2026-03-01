const View = require('../../src/View')

describe('View.print()', () => {
  let view
  let mockOdac

  beforeEach(() => {
    mockOdac = {
      Config: {view: {earlyHints: {enabled: false}}},
      View: {},
      Request: {data: {all: {}}}
    }
    view = new View(mockOdac)
  })

  it('should be a function', () => {
    expect(typeof view.print).toBe('function')
  })
})
