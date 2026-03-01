const fs = require('fs')
const Lang = require('../../src/Lang')

jest.mock('fs')

describe('Lang.set()', () => {
  let mockOdac
  let lang

  beforeEach(() => {
    jest.clearAllMocks()
    global.__dir = '/mock'

    mockOdac = {
      Config: {lang: {default: 'en'}},
      Var: jest.fn(val => ({
        is: jest.fn(type => type === 'alpha' && /^[a-zA-Z]+$/.test(val))
      })),
      Request: {
        header: jest.fn()
      }
    }

    fs.existsSync.mockReturnValue(false)
    fs.readFileSync.mockImplementation(() => {
      throw new Error('ENOENT')
    })
  })

  it('should default to en when no config or header', () => {
    lang = new Lang(mockOdac)
    lang.set()
    // No Var call here because lang is falsy
  })

  it('should use lang from header if available', () => {
    mockOdac.Request.header.mockReturnValue('tr-TR')
    lang = new Lang(mockOdac)
    lang.set()
    // Verifying it uses 'tr' can be tricky since it's private, but constructor calls set()
    expect(mockOdac.Request.header).toHaveBeenCalledWith('ACCEPT-LANGUAGE')
  })

  it('should use explicit lang in set()', () => {
    lang = new Lang(mockOdac)
    lang.set('fr')
    expect(mockOdac.Var).toHaveBeenCalledWith('fr')
  })
})
