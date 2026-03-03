const fs = require('fs')
const Lang = require('../../src/Lang')

jest.mock('fs')

describe('Lang.get()', () => {
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
    fs.mkdirSync.mockImplementation(() => {})
    fs.writeFileSync.mockImplementation(() => {})
    fs.readFileSync.mockImplementation(() => {
      throw new Error('ENOENT')
    })

    lang = new Lang(mockOdac)
  })

  it('should return matching string and support placeholders', () => {
    fs.existsSync.mockImplementation(path => path.includes('/tr.json'))
    fs.readFileSync.mockReturnValue(
      JSON.stringify({
        welcome: 'Merhaba %s!'
      })
    )

    lang.set('tr')
    expect(lang.get('welcome', 'Emre')).toBe('Merhaba Emre!')
  })

  it('should support numbered placeholders', () => {
    fs.existsSync.mockImplementation(path => path.includes('/en.json'))
    fs.readFileSync.mockReturnValue(
      JSON.stringify({
        order: 'First: %s1, Second: %s2'
      })
    )

    lang.set('en')
    expect(lang.get('order', 'A', 'B')).toBe('First: A, Second: B')
  })

  it('should auto-save new keys', () => {
    lang.set('en')
    const result = lang.get('new_key')

    expect(result).toBe('new_key')
    expect(fs.writeFileSync).toHaveBeenCalledWith(expect.stringContaining('/en.json'), expect.stringContaining('"new_key": "new_key"'))
  })
})
