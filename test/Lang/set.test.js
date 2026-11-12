const fs = require('fs')
const Lang = require('../../src/Lang')

jest.mock('fs', () => ({promises: {readFile: jest.fn(async () => '{}'), stat: jest.fn(async () => ({mtimeMs: 1}))}}))

// The language code reaches a filesystem path on the first lookup.
const languagePaths = () => fs.promises.readFile.mock.calls.map(c => c[0]).filter(p => p.includes('/storage/language/'))

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

    Lang.store.reset()
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
  it('rejects a malicious ACCEPT-LANGUAGE header and falls back to a safe code', async () => {
    mockOdac.Request.header.mockReturnValue('a/../../etc/passwd')
    await new Lang(mockOdac).get('x')
    const checkedPaths = languagePaths()
    expect(checkedPaths.length).toBeGreaterThan(0)
    // No path may be derived from the 'a/' slice; all must be <2 letters>.json
    expect(checkedPaths.every(p => /\/[a-z]{2}\.json$/.test(p))).toBe(true)
    expect(checkedPaths).toContain('/mock/storage/language/en.json')
  })

  it('normalizes an uppercase language code to a lowercase file path', async () => {
    lang = new Lang(mockOdac)
    lang.set('EN')
    await lang.get('x')
    const checkedPaths = languagePaths()
    expect(checkedPaths).toContain('/mock/storage/language/en.json')
  })

  it('reports the active language through current()', () => {
    mockOdac.Config.lang.supported = ['tr', 'de']
    mockOdac.Request.header.mockReturnValue('tr-TR')
    lang = new Lang(mockOdac)
    expect(lang.current()).toBe('tr')

    lang.set('DE')
    expect(lang.current()).toBe('de')

    // An invalid code falls back to the header, never to the raw value.
    lang.set('../')
    expect(lang.current()).toBe('tr')
  })

  it('falls back to en when both header and configured default are invalid', async () => {
    mockOdac.Config.lang.default = 'english' // not a 2-letter code
    mockOdac.Request.header.mockReturnValue('') // no usable header
    await new Lang(mockOdac).get('x')
    const checkedPaths = languagePaths()
    expect(checkedPaths.every(p => /\/[a-z]{2}\.json$/.test(p))).toBe(true)
    expect(checkedPaths).toContain('/mock/storage/language/en.json')
  })
})
