const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const Lang = require('../../src/Lang')

// Regional and script variants (pt-BR, zh-Hant): selected from Accept-Language and set(),
// and a regional file holds only what differs from its language.
describe('Lang regional languages', () => {
  let root
  let header
  let mockOdac
  let warnings

  const write = (file, content) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), {recursive: true})
    fs.writeFileSync(path.join(root, file), JSON.stringify(content))
  }
  const read = code => JSON.parse(fs.readFileSync(path.join(root, 'lang', `${code}.json`), 'utf8'))
  const lang = code => {
    const instance = new Lang(mockOdac)
    if (code !== undefined) instance.set(code)
    return instance
  }

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'odac-lang-locale-'))
    global.__dir = root
    Lang.store.reset()
    Lang.frontendKeys.reset()
    header = null
    warnings = []
    jest.spyOn(console, 'error').mockImplementation(line => warnings.push(JSON.parse(line)))
    mockOdac = {
      Config: {debug: false, lang: {default: 'en'}},
      Request: {header: name => (name === 'ACCEPT-LANGUAGE' ? header : null)}
    }
    write('lang/en.json', {Hello: 'Hello', Bus: 'Bus', Train: 'Train', Only: 'Only English'})
    write('lang/pt.json', {Hello: 'Olá', Bus: 'Autocarro', Train: 'Comboio', Only: ''})
    write('lang/pt-BR.json', {Hello: '', Bus: 'Ônibus', Train: 'Trem', Only: ''})
    write('lang/zh-Hant.json', {Hello: '你好'})
    write('lang/zh-Hans.json', {Hello: '你好 (简体)'})
    await Lang.store.init(mockOdac.Config)
  })

  afterEach(() => {
    Lang.store.reset()
    Lang.frontendKeys.reset()
    jest.restoreAllMocks()
    fs.rmSync(root, {recursive: true, force: true})
  })

  it('lists regional and script files as languages', () => {
    expect([...Lang.store.languages(mockOdac.Config)].sort()).toEqual(['en', 'pt', 'pt-BR', 'zh-Hans', 'zh-Hant'])
  })

  describe('selection', () => {
    it('serves the exact regional language a browser asks for', () => {
      header = 'pt-BR,pt;q=0.9,en;q=0.8'
      expect(lang().current()).toBe('pt-BR')
    })

    it('serves the language of a region it has no file for', () => {
      header = 'pt-AO'
      expect(lang().current()).toBe('pt')
    })

    it('serves the script a browser region implies', () => {
      header = 'zh-TW'
      expect(lang().current()).toBe('zh-Hant')
      header = 'zh-CN,zh;q=0.9'
      expect(lang().current()).toBe('zh-Hans')
    })

    it('drops subtags it does not use instead of the whole range', () => {
      header = 'pt-BR-x-private;q=0.9, fr'
      expect(lang().current()).toBe('pt-BR')
    })

    it('accepts set() codes in any case and with an underscore', () => {
      expect(lang('PT_br').current()).toBe('pt-BR')
      expect(lang('zh-hant').current()).toBe('zh-Hant')
    })

    it('matches set() codes the same way as Accept-Language', () => {
      expect(lang('pt-PT').current()).toBe('pt')
      expect(lang('zh-TW').current()).toBe('zh-Hant')
    })

    it('rejects codes that are not language[-Script][-REGION]', () => {
      header = 'pt-BR'
      for (const code of ['../pt', 'pt-BR/../../x', 'pt-BR-x', 'portuguese']) expect(lang(code).current()).toBe('pt-BR')
    })
  })

  describe('translation', () => {
    it('uses the regional translation first', () => {
      expect(lang('pt-BR').get('Bus')).toBe('Ônibus')
    })

    it('serves what a regional file leaves empty from its language', () => {
      expect(lang('pt-BR').get('Hello')).toBe('Olá')
    })

    it('serves what neither translates from the default language', () => {
      expect(lang('pt-BR').get('Only')).toBe('Only English')
    })

    it('does not report text served from the parent language as missing', () => {
      mockOdac.Config.debug = true
      mockOdac.Config.lang.collect = false
      mockOdac.Config.lang.highlightMissing = true
      expect(lang('pt-BR').get('Hello')).toBe('Olá')
      expect(warnings.filter(w => w.message === 'Missing translation')).toEqual([])
      expect(lang('pt-BR').get('Only')).toBe('⟦Only English⟧')
      expect(warnings.filter(w => w.message === 'Missing translation')).toHaveLength(1)
    })

    it('adds collected keys to regional files as untranslated', async () => {
      mockOdac.Config.debug = true
      lang('pt-BR').get('New key')
      await Lang.store.flush()
      expect(read('pt-BR')['New key']).toBe('')
      expect(read('pt')['New key']).toBe('')
      expect(read('en')['New key']).toBe('New key')
    })
  })

  describe('served()', () => {
    it('declares the canonical regional code and its direction', () => {
      header = 'pt-br'
      expect(lang().served()).toEqual({lang: 'pt-BR', dir: 'ltr', varies: true})
    })

    it('does not vary when set() picked the language, even through matching', () => {
      header = 'en'
      expect(lang('pt-PT').served()).toEqual({lang: 'pt', dir: 'ltr', varies: false})
    })

    it('declares right to left for a regional Arabic file', async () => {
      write('lang/ar-EG.json', {})
      Lang.store.reset()
      await Lang.store.init(mockOdac.Config)
      expect(lang('ar-EG').served()).toEqual({lang: 'ar-EG', dir: 'rtl', varies: false})
      expect(lang('ar-EG').dir()).toBe('rtl')
    })
  })

  describe('client()', () => {
    it('sends the browser the regional translations with the same fallbacks', async () => {
      write('view/js/app.js', "Odac.__('Hello'); Odac.__('Bus'); Odac.__('Only')")
      const payload = await lang('pt-BR').client()
      expect(payload.lang).toBe('pt-BR')
      expect(payload.t).toEqual({Bus: 'Ônibus', Hello: 'Olá', Only: 'Only English'})
    })

    it('rebuilds the translations when a parent language file changes', async () => {
      write('view/js/app.js', "Odac.__('Hello')")
      const before = await lang('pt-BR').client()
      expect(before.t.Hello).toBe('Olá')
      write('lang/pt.json', {Hello: 'Oi'})
      const future = new Date(Date.now() + 10000)
      fs.utimesSync(path.join(root, 'lang/pt.json'), future, future)
      const now = Date.now()
      jest.spyOn(Date, 'now').mockImplementation(() => now + 5000)
      Lang.store.load('pt')
      await Lang.store.settle()
      const after = await lang('pt-BR').client()
      expect(after.t.Hello).toBe('Oi')
      expect(after.v).not.toBe(before.v)
    })
  })
})
