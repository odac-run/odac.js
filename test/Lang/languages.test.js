const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const Lang = require('../../src/Lang')

// Language selection only ever picks a language the application has: a file in
// storage/language/ or an entry of lang.supported. Accept-Language is client input.
describe('Lang language selection', () => {
  let tmpDir
  let langDir
  let header
  let mockOdac

  const writeLang = (code, data) => fs.writeFileSync(path.join(langDir, `${code}.json`), JSON.stringify(data))
  const waitForSave = () => new Promise(resolve => setTimeout(resolve, 600))

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'odac-lang-select-'))
    langDir = path.join(tmpDir, 'storage/language')
    fs.mkdirSync(langDir, {recursive: true})
    global.__dir = tmpDir
    Lang.store.reset()
    header = null
    mockOdac = {
      Config: {debug: true, lang: {default: 'en'}},
      Var: val => ({is: type => type === 'alpha' && /^[a-zA-Z]+$/.test(val)}),
      Request: {header: name => (name === 'ACCEPT-LANGUAGE' ? header : null)}
    }
  })

  afterEach(() => {
    Lang.store.reset()
    jest.restoreAllMocks()
    fs.rmSync(tmpDir, {recursive: true, force: true})
  })

  it('serves the default language for an Accept-Language it has no file for', async () => {
    writeLang('en', {hello: 'Hello'})
    await Lang.store.init()
    header = 'zz'
    const lang = new Lang(mockOdac)
    expect(lang.current()).toBe('en')
    expect(await lang.get('hello')).toBe('Hello')
  })

  it('never creates a language file because a client asked for that language', async () => {
    await Lang.store.init()
    header = 'zz,qq;q=0.5'
    await new Lang(mockOdac).get('missing')
    await waitForSave()
    expect(fs.readdirSync(langDir)).toEqual(['en.json'])
  })

  it('picks the most preferred supported language of the header', async () => {
    writeLang('en', {})
    writeLang('tr', {hello: 'Merhaba'})
    await Lang.store.init()
    header = 'de-DE,de;q=0.9,tr;q=0.8,en;q=0.7'
    expect(new Lang(mockOdac).current()).toBe('tr')
  })

  it('honours q values over header order and skips q=0', async () => {
    writeLang('tr', {})
    writeLang('fr', {})
    await Lang.store.init()
    header = 'fr;q=0.2, tr;q=0.9'
    expect(new Lang(mockOdac).current()).toBe('tr')
    header = 'tr;q=0, fr'
    expect(new Lang(mockOdac).current()).toBe('fr')
  })

  it('ignores ranges that are not a two-letter language', async () => {
    writeLang('tr', {})
    await Lang.store.init()
    header = 'turkish, *, tr'
    expect(new Lang(mockOdac).current()).toBe('tr')
    header = 'trx'
    expect(new Lang(mockOdac).current()).toBe('en')
  })

  it('falls back from an unsupported explicit code to the header, then the default', async () => {
    writeLang('tr', {})
    await Lang.store.init()
    header = 'tr'
    const lang = new Lang(mockOdac)
    lang.set('de')
    expect(lang.current()).toBe('tr')
    header = null
    lang.set('de')
    expect(lang.current()).toBe('en')
  })

  it('treats lang.supported as a strict whitelist that includes the default', async () => {
    writeLang('fr', {hello: 'Bonjour'})
    await Lang.store.init()
    mockOdac.Config.lang = {default: 'en', supported: ['tr', 'DE', 'bad!', 42]}
    const lang = new Lang(mockOdac)
    lang.set('fr')
    expect(lang.current()).toBe('en')
    lang.set('de')
    expect(lang.current()).toBe('de')
    lang.set('en')
    expect(lang.current()).toBe('en')
  })

  it('resolves the language on first lookup when the directory was not listed yet', async () => {
    writeLang('tr', {hello: 'Merhaba'})
    header = 'tr'
    const lang = new Lang(mockOdac)
    expect(await lang.get('hello')).toBe('Merhaba')
    expect(lang.current()).toBe('tr')
  })

  it('notices a language file added at runtime', async () => {
    await Lang.store.init()
    header = 'tr'
    expect(new Lang(mockOdac).current()).toBe('en')

    writeLang('tr', {})
    const now = Date.now()
    jest.spyOn(Date, 'now').mockReturnValue(now + 3000)
    new Lang(mockOdac) // triggers the background rescan
    await Lang.store.init()
    expect(new Lang(mockOdac).current()).toBe('tr')
  })

  it('ignores files in the language directory that are not language files', async () => {
    writeLang('tr', {})
    fs.writeFileSync(path.join(langDir, 'tr.json.123.tmp'), '{}')
    fs.writeFileSync(path.join(langDir, 'xyz.json'), '{}')
    fs.writeFileSync(path.join(langDir, 'TR.json'), '{}')
    await Lang.store.init()
    expect([...Lang.store.languages(mockOdac.Config)].sort()).toEqual(['en', 'tr'])
  })
  describe('served()', () => {
    it('declares the negotiated language and that it varies with Accept-Language', async () => {
      writeLang('en', {})
      writeLang('ar', {})
      await Lang.store.init()
      header = 'ar,en;q=0.5'
      const lang = new Lang(mockOdac)
      expect(lang.dir()).toBe('rtl')
      expect(await lang.served()).toEqual({lang: 'ar', dir: 'rtl', varies: true})
    })

    it('still varies when the header selects the default language', async () => {
      writeLang('tr', {})
      await Lang.store.init()
      header = 'de'
      expect(await new Lang(mockOdac).served()).toEqual({lang: 'en', dir: 'ltr', varies: true})
    })

    it('does not vary with the header for a language chosen through set()', async () => {
      writeLang('tr', {})
      await Lang.store.init()
      header = 'en'
      const lang = new Lang(mockOdac)
      lang.set('tr')
      expect(await lang.served()).toEqual({lang: 'tr', dir: 'ltr', varies: false})
    })

    it('varies again when the code passed to set() is not supported', async () => {
      writeLang('tr', {})
      await Lang.store.init()
      header = 'tr'
      const lang = new Lang(mockOdac)
      lang.set('de')
      expect(await lang.served()).toEqual({lang: 'tr', dir: 'ltr', varies: true})
    })

    it('declares a single configured language without varying', async () => {
      await Lang.store.init()
      mockOdac.Config = {lang: {default: 'tr'}}
      header = 'en'
      expect(await new Lang(mockOdac).served()).toEqual({lang: 'tr', dir: 'ltr', varies: false})
      mockOdac.Config = {lang: {supported: []}}
      expect(await new Lang(mockOdac).served()).toEqual({lang: 'en', dir: 'ltr', varies: false})
    })

    it('declares nothing for an application that declares no languages', async () => {
      await Lang.store.init()
      mockOdac.Config = {}
      header = 'tr'
      expect(await new Lang(mockOdac).served()).toBeNull()
    })
  })
})

describe('Lang fallback', () => {
  let tmpDir
  let langDir
  let mockOdac

  const writeLang = (code, data) => fs.writeFileSync(path.join(langDir, `${code}.json`), JSON.stringify(data))

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'odac-lang-fallback-'))
    langDir = path.join(tmpDir, 'storage/language')
    fs.mkdirSync(langDir, {recursive: true})
    global.__dir = tmpDir
    Lang.store.reset()
    mockOdac = {
      Config: {debug: false, lang: {default: 'en'}},
      Var: val => ({is: type => type === 'alpha' && /^[a-zA-Z]+$/.test(val)}),
      Request: {header: () => null}
    }
  })

  afterEach(() => {
    Lang.store.reset()
    fs.rmSync(tmpDir, {recursive: true, force: true})
  })

  it('falls back to the default language before the key', async () => {
    writeLang('en', {'nav.home': 'Home', 'nav.about': 'About'})
    writeLang('tr', {'nav.home': 'Ana Sayfa', 'nav.about': ''})
    await Lang.store.init()
    const lang = new Lang(mockOdac)
    lang.set('tr')
    expect(await lang.get('nav.home')).toBe('Ana Sayfa')
    expect(await lang.get('nav.about')).toBe('About')
    expect(await lang.get('nav.unknown')).toBe('nav.unknown')
  })

  it('applies placeholders to the fallback translation', async () => {
    writeLang('en', {greet: 'Hello %s1'})
    writeLang('tr', {})
    await Lang.store.init()
    const lang = new Lang(mockOdac)
    lang.set('tr')
    expect(await lang.get('greet', 'Emre')).toBe('Hello Emre')
  })
})
