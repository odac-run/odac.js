const fs = require('fs')
const Lang = require('../../src/Lang')

jest.mock('fs', () => ({
  promises: {
    mkdir: jest.fn(),
    writeFile: jest.fn(),
    access: jest.fn()
  },
  existsSync: jest.fn(),
  mkdirSync: jest.fn(),
  writeFileSync: jest.fn(),
  readFileSync: jest.fn()
}))

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
    fs.promises.mkdir.mockResolvedValue()
    fs.promises.writeFile.mockResolvedValue()
    fs.readFileSync.mockImplementation(() => {
      throw new Error('ENOENT')
    })

    lang = new Lang(mockOdac)
  })

  it('should return matching string and support placeholders', async () => {
    fs.existsSync.mockImplementation(path => path.includes('/tr.json'))
    fs.readFileSync.mockReturnValue(
      JSON.stringify({
        welcome: 'Merhaba %s!'
      })
    )

    lang.set('tr')
    expect(await lang.get('welcome', 'Emre')).toBe('Merhaba Emre!')
  })

  it('should support numbered placeholders', async () => {
    fs.existsSync.mockImplementation(path => path.includes('/en.json'))
    fs.readFileSync.mockReturnValue(
      JSON.stringify({
        order: 'First: %s1, Second: %s2'
      })
    )

    lang.set('en')
    expect(await lang.get('order', 'A', 'B')).toBe('First: A, Second: B')
  })

  it('should auto-save new keys', async () => {
    lang.set('en')
    const result = await lang.get('new_key')

    expect(result).toBe('new_key')
    expect(fs.promises.writeFile).toHaveBeenCalledWith(expect.stringContaining('/en.json'), expect.stringContaining('"new_key": "new_key"'))
  })

  it('should set language from ACCEPT-LANGUAGE header', () => {
    mockOdac.Request.header.mockImplementation(name => {
      if (name === 'ACCEPT-LANGUAGE') return 'tr-TR,tr;q=0.9'
      return null
    })

    lang.set()
    // We check internal #lang via side effect or just trust the logic if we can't access private field easily.
    // But we can check if it tries to read tr.json
    fs.existsSync.mockImplementation(path => path.includes('/tr.json'))
    fs.readFileSync.mockReturnValue('{}')

    lang.set()
    expect(fs.readFileSync).toHaveBeenCalledWith(expect.stringContaining('/tr.json'), 'utf8')
  })
})
