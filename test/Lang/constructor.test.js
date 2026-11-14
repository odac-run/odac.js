const Lang = require('../../src/Lang')

describe('Lang.constructor()', () => {
  let mockOdac

  beforeEach(() => {
    mockOdac = {
      Config: {lang: {default: 'en'}},
      Var: jest.fn(() => ({is: () => true})),
      Request: {header: jest.fn()}
    }
    global.__dir = '/mock'
  })

  it('should initialize successfully', () => {
    const lang = new Lang(mockOdac)
    expect(lang).toBeDefined()
  })

  it('selects the language passed to set()', () => {
    const lang = new Lang(mockOdac)
    lang.set('en')
    expect(lang.current()).toBe('en')
  })
})
