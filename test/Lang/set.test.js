const fs = require('fs')
const Lang = require('../../src/Lang')

jest.mock('fs', () => ({promises: {readFile: jest.fn(async () => '{}'), stat: jest.fn(async () => ({mtimeMs: 1}))}}))

// The language code reaches a filesystem path on the first lookup.
const languagePaths = () => fs.promises.readFile.mock.calls.map(c => c[0]).filter(p => p.includes('/lang/'))

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
    mockOdac.Config.lang.supported = ['fr']
    lang = new Lang(mockOdac)
    lang.set('fr')
    expect(lang.current()).toBe('fr')
  })

  // 1.12 — a language code must never build a filesystem path from unvalidated
  // input. Every language file path must end in exactly two lowercase letters.
  it('rejects a malicious ACCEPT-LANGUAGE header and falls back to a safe code', async () => {
    mockOdac.Request.header.mockReturnValue('a/../../etc/passwd')
    await new Lang(mockOdac).get('x')
    await Lang.store.settle()
    const checkedPaths = languagePaths()
    expect(checkedPaths.length).toBeGreaterThan(0)
    // No path may be derived from the 'a/' slice; all must be canonical language codes
    expect(checkedPaths.every(p => /\/[a-z]{2,3}(-[A-Za-z0-9]+)*\.json$/.test(p))).toBe(true)
    expect(checkedPaths).toContain('/mock/lang/en.json')
  })

  it('normalizes an uppercase language code to a lowercase file path', async () => {
    lang = new Lang(mockOdac)
    lang.set('EN')
    await lang.get('x')
    await Lang.store.settle()
    const checkedPaths = languagePaths()
    expect(checkedPaths).toContain('/mock/lang/en.json')
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
    await Lang.store.settle()
    const checkedPaths = languagePaths()
    expect(checkedPaths.every(p => /\/[a-z]{2,3}(-[A-Za-z0-9]+)*\.json$/.test(p))).toBe(true)
    expect(checkedPaths).toContain('/mock/lang/en.json')
  })
})
