const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const Lang = require('../../src/Lang')

describe('Lang.get()', () => {
  let mockOdac
  let tmpDir
  let langDir

  const writeLang = (code, data) => fs.writeFileSync(path.join(langDir, `${code}.json`), JSON.stringify(data))
  const readLang = code => JSON.parse(fs.readFileSync(path.join(langDir, `${code}.json`), 'utf8'))
  const waitForSave = () => new Promise(resolve => setTimeout(resolve, 600))

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'odac-lang-'))
    langDir = path.join(tmpDir, 'lang')
    fs.mkdirSync(langDir, {recursive: true})
    global.__dir = tmpDir
    Lang.store.reset()

    mockOdac = {
      Config: {debug: true, lang: {default: 'en'}},
      Var: jest.fn(val => ({
        is: jest.fn(type => type === 'alpha' && /^[a-zA-Z]+$/.test(val))
      })),
      Request: {header: jest.fn()}
    }
  })

  afterEach(() => {
    Lang.store.reset()
    jest.restoreAllMocks()
    fs.rmSync(tmpDir, {recursive: true, force: true})
  })

  it('should return matching string and support placeholders', async () => {
    writeLang('tr', {welcome: 'Merhaba %s!'})
    await Lang.store.init()
    const lang = new Lang(mockOdac)
    lang.set('tr')
    expect(await lang.get('welcome', 'Emre')).toBe('Merhaba Emre!')
  })

  it('should support numbered placeholders', async () => {
    writeLang('en', {order: 'First: %s1, Second: %s2'})
    await Lang.store.init()
    const lang = new Lang(mockOdac)
    expect(await lang.get('order', 'A', 'B')).toBe('First: A, Second: B')
  })

  it('should not expand replacement patterns in placeholder values', async () => {
    writeLang('en', {price: 'Total: %s', pair: '%s1 / %s2'})
    await Lang.store.init()
    const lang = new Lang(mockOdac)
    expect(await lang.get('price', "$& $'")).toBe("Total: $& $'")
    expect(await lang.get('pair', '$1', '$&')).toBe('$1 / $&')
  })

  it('should treat Object.prototype names as ordinary keys', async () => {
    const lang = new Lang(mockOdac)
    expect(await lang.get('constructor')).toBe('constructor')
    expect(await lang.get('toString')).toBe('toString')
  })

  it('should auto-save new keys in debug mode', async () => {
    await Lang.store.init()
    const lang = new Lang(mockOdac)
    expect(await lang.get('new_key')).toBe('new_key')
    await waitForSave()
    expect(readLang('en')).toEqual({new_key: 'new_key'})
  })

  it('should merge collected keys with the file instead of overwriting it', async () => {
    writeLang('en', {existing: 'Existing'})
    await Lang.store.init()
    const lang = new Lang(mockOdac)
    await lang.get('first_missing')
    // Another worker adds a translation in the meantime.
    writeLang('en', {existing: 'Existing', other_worker: 'Other'})
    await lang.get('second_missing')
    await waitForSave()

    expect(readLang('en')).toEqual({
      existing: 'Existing',
      other_worker: 'Other',
      first_missing: 'first_missing',
      second_missing: 'second_missing'
    })
  })

  it('should not write to disk outside debug mode unless lang.collect is enabled', async () => {
    mockOdac.Config.debug = false
    const lang = new Lang(mockOdac)
    await lang.get('missing')
    await waitForSave()
    expect(fs.existsSync(path.join(langDir, 'en.json'))).toBe(false)

    mockOdac.Config.lang.collect = true
    await lang.get('missing')
    await waitForSave()
    expect(readLang('en')).toEqual({missing: 'missing'})
  })

  it('should read the language file once for many requests', async () => {
    writeLang('en', {hello: 'Hello'})
    const readFile = jest.spyOn(fs.promises, 'readFile')
    await Lang.store.init()

    const results = Array.from({length: 20}, () => new Lang(mockOdac).get('hello'))

    expect(results.every(value => value === 'Hello')).toBe(true)
    expect(readFile).toHaveBeenCalledTimes(1)
  })

  it('should return a string, not a promise', async () => {
    writeLang('en', {hello: 'Hello %s1'})
    await Lang.store.init()
    const lang = new Lang(mockOdac)
    const message = lang.get('hello', 'Emre')
    expect(message).toBe('Hello Emre')
    expect(`${lang.getx('hello', 'greeting')}!`).toBe('hello!')
  })

  it('should load every language file before the first lookup', async () => {
    writeLang('en', {hello: 'Hello'})
    writeLang('tr', {hello: 'Merhaba'})
    writeLang('de', {hello: 'Hallo'})
    const readFile = jest.spyOn(fs.promises, 'readFile')
    await Lang.store.init()
    readFile.mockClear()

    const lang = new Lang(mockOdac)
    lang.set('de')
    expect(lang.get('hello')).toBe('Hallo')
    lang.set('tr')
    expect(lang.get('hello')).toBe('Merhaba')
    expect(readFile).not.toHaveBeenCalled()
  })

  it('should serve keys untranslated, and warn once in debug mode, before the files are loaded', async () => {
    writeLang('tr', {hello: 'Merhaba'})
    const error = jest.spyOn(console, 'error').mockImplementation(() => {})
    mockOdac.Request.header.mockReturnValue('tr')
    const lang = new Lang(mockOdac)

    expect(lang.get('hello')).toBe('hello')
    expect(lang.get('hello')).toBe('hello')
    const warnings = error.mock.calls.filter(([line]) => line.includes('before the language files were loaded'))
    expect(warnings).toHaveLength(1)

    // The constructor started loading them; the same instance translates once they are in.
    await Lang.store.init()
    expect(lang.get('hello')).toBe('Merhaba')
    expect(lang.current()).toBe('tr')
    // Keys looked up before the files were loaded are not collected as missing.
    await Lang.store.flush()
    expect(fs.readdirSync(langDir)).toEqual(['tr.json'])
    expect(readLang('tr')).toEqual({hello: 'Merhaba'})
  })

  it('should not touch the filesystem when constructed', () => {
    const readFile = jest.spyOn(fs.promises, 'readFile')
    const readFileSync = jest.spyOn(fs, 'readFileSync')

    new Lang(mockOdac)

    expect(readFile).not.toHaveBeenCalled()
    expect(readFileSync).not.toHaveBeenCalled()
  })

  it('should pick up an edited language file', async () => {
    writeLang('en', {hello: 'Hello'})
    await Lang.store.init()
    const lang = new Lang(mockOdac)
    expect(lang.get('hello')).toBe('Hello')

    writeLang('en', {hello: 'Hi'})
    const future = new Date(Date.now() + 5000)
    fs.utimesSync(path.join(langDir, 'en.json'), future, future)
    jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 3000)

    // The lookup that notices the change is served from memory; the next one is not.
    expect(lang.get('hello')).toBe('Hello')
    await Lang.store.settle()
    expect(lang.get('hello')).toBe('Hi')
  })

  it('should use the language from the ACCEPT-LANGUAGE header', async () => {
    writeLang('tr', {hello: 'Merhaba'})
    await Lang.store.init()
    mockOdac.Request.header.mockImplementation(name => (name === 'ACCEPT-LANGUAGE' ? 'tr-TR,tr;q=0.9' : null))
    expect(await new Lang(mockOdac).get('hello')).toBe('Merhaba')
  })
})

describe('Lang.getx()', () => {
  let mockOdac
  let tmpDir
  let langDir

  const writeLang = (code, data) => fs.writeFileSync(path.join(langDir, `${code}.json`), JSON.stringify(data))
  const readLang = code => JSON.parse(fs.readFileSync(path.join(langDir, `${code}.json`), 'utf8'))
  const waitForSave = () => new Promise(resolve => setTimeout(resolve, 600))

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'odac-lang-ctx-'))
    langDir = path.join(tmpDir, 'lang')
    fs.mkdirSync(langDir, {recursive: true})
    global.__dir = tmpDir
    Lang.store.reset()
    mockOdac = {
      Config: {debug: true, lang: {default: 'tr'}},
      Var: val => ({is: type => type === 'alpha' && /^[a-zA-Z]+$/.test(val)}),
      Request: {header: () => null}
    }
  })

  afterEach(() => {
    Lang.store.reset()
    fs.rmSync(tmpDir, {recursive: true, force: true})
  })

  it('translates the same text differently per context', async () => {
    writeLang('tr', {})
    writeLang('en', {Gül: {'': 'Gül', flower: 'Rose', verb: 'Smile'}})
    await Lang.store.init()
    const lang = new Lang(mockOdac)
    lang.set('en')
    expect(await lang.getx('Gül', 'flower')).toBe('Rose')
    expect(await lang.getx('Gül', 'verb')).toBe('Smile')
    expect(await lang.get('Gül')).toBe('Gül')
  })

  it('treats an empty or missing context as the plain entry', async () => {
    writeLang('tr', {Kaydet: 'Kaydet'})
    await Lang.store.init()
    const lang = new Lang(mockOdac)
    expect(await lang.getx('Kaydet', '  ')).toBe('Kaydet')
    expect(await lang.getx('Kaydet', undefined)).toBe('Kaydet')
  })

  it('never falls back to the translation of another context', async () => {
    writeLang('tr', {})
    writeLang('en', {Gül: 'Rose'})
    await Lang.store.init()
    mockOdac.Config.debug = false
    const lang = new Lang(mockOdac)
    lang.set('en')
    expect(await lang.getx('Gül', 'verb')).toBe('Gül')
  })

  it('falls back to the same context in the default language', async () => {
    writeLang('tr', {Gül: {verb: 'Gülümse'}})
    writeLang('en', {Gül: {verb: ''}})
    await Lang.store.init()
    mockOdac.Config.debug = false
    const lang = new Lang(mockOdac)
    lang.set('en')
    expect(await lang.getx('Gül', 'verb', 1)).toBe('Gülümse')
  })

  it('applies placeholders after the context argument', async () => {
    writeLang('tr', {'%s1 gül': {flower: '%s1 rose'}})
    await Lang.store.init()
    expect(await new Lang(mockOdac).getx('%s1 gül', 'flower', 3)).toBe('3 rose')
  })

  it('collects a new context next to the existing plain translation', async () => {
    writeLang('tr', {Gül: 'Gül'})
    await Lang.store.init()
    await new Lang(mockOdac).getx('Gül', 'verb')
    await waitForSave()
    expect(readLang('tr')).toEqual({Gül: {'': 'Gül', verb: 'Gül'}})
  })
})
