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

  // 1.12 — a language code must never build a filesystem path from unvalidated
  // input. Every language file path must end in exactly two lowercase letters.
  it('rejects a malicious ACCEPT-LANGUAGE header and falls back to a safe code', () => {
    mockOdac.Request.header.mockReturnValue('a/../../etc/passwd')
    new Lang(mockOdac)
    const checkedPaths = fs.existsSync.mock.calls.map(c => c[0]).filter(p => p.includes('/storage/language/'))
    expect(checkedPaths.length).toBeGreaterThan(0)
    // No path may be derived from the 'a/' slice; all must be <2 letters>.json
    expect(checkedPaths.every(p => /\/[a-z]{2}\.json$/.test(p))).toBe(true)
    expect(checkedPaths).toContain('/mock/storage/language/en.json')
  })

  it('normalizes an uppercase language code to a lowercase file path', () => {
    lang = new Lang(mockOdac)
    fs.existsSync.mockClear()
    lang.set('EN')
    const checkedPaths = fs.existsSync.mock.calls.map(c => c[0]).filter(p => p.includes('/storage/language/'))
    expect(checkedPaths).toContain('/mock/storage/language/en.json')
  })

  it('falls back to en when both header and configured default are invalid', () => {
    mockOdac.Config.lang.default = 'english' // not a 2-letter code
    mockOdac.Request.header.mockReturnValue('') // no usable header
    new Lang(mockOdac)
    const checkedPaths = fs.existsSync.mock.calls.map(c => c[0]).filter(p => p.includes('/storage/language/'))
    expect(checkedPaths.every(p => /\/[a-z]{2}\.json$/.test(p))).toBe(true)
    expect(checkedPaths).toContain('/mock/storage/language/en.json')
  })
})
