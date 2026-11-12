const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const Lang = require('../../src/Lang')

// The browser receives only the entries view/js uses, already resolved for its language.
describe('Lang.client()', () => {
  let root
  let mockOdac

  const write = (file, content) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), {recursive: true})
    fs.writeFileSync(path.join(root, file), typeof content === 'string' ? content : JSON.stringify(content))
  }
  const readLang = code => JSON.parse(fs.readFileSync(path.join(root, 'storage/language', `${code}.json`), 'utf8'))
  const tr = () => {
    const lang = new Lang(mockOdac)
    lang.set('tr')
    return lang
  }

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'odac-lang-client-'))
    global.__dir = root
    Lang.store.reset()
    Lang.frontendKeys.reset()
    mockOdac = {
      Config: {debug: false, lang: {default: 'en'}},
      Var: val => ({is: type => type === 'alpha' && /^[a-zA-Z]+$/.test(val)}),
      Request: {header: () => null}
    }
    write('view/js/app.js', "Odac.__('Hello'); Odac.__x('Gül', 'verb'); Odac.__('Only English'); Odac.__('Untranslated')")
    write('controller/admin.js', "Odac.__('Admin secret')")
    write('storage/language/en.json', {
      Hello: 'Hello',
      Gül: {verb: 'Smile', flower: 'Rose'},
      'Only English': 'Only English',
      Untranslated: '',
      'Admin secret': 'Admin secret'
    })
    write('storage/language/tr.json', {Hello: 'Merhaba', Gül: {verb: 'Gülümse', flower: 'Gül'}, 'Admin secret': 'Gizli'})
    await Lang.store.init()
  })

  afterEach(() => {
    Lang.store.reset()
    Lang.frontendKeys.reset()
    jest.restoreAllMocks()
    fs.rmSync(root, {recursive: true, force: true})
  })

  it('contains only entries used in view/js, resolved with the default-language fallback', async () => {
    const payload = await tr().client()
    expect(payload.lang).toBe('tr')
    expect(JSON.parse(JSON.stringify(payload.t))).toEqual({Gül: {verb: 'Gülümse'}, Hello: 'Merhaba', 'Only English': 'Only English'})
  })

  it('returns null when the frontend uses no translations', async () => {
    fs.rmSync(path.join(root, 'view/js'), {recursive: true})
    expect(await tr().client()).toBeNull()
  })

  it('returns the same object until an input changes', async () => {
    const first = await tr().client()
    expect(await tr().client()).toBe(first)

    write('storage/language/tr.json', {Hello: 'Selam'})
    const future = new Date(Date.now() + 5000)
    fs.utimesSync(path.join(root, 'storage/language/tr.json'), future, future)
    jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 3000)
    await tr().client() // notices the edit; re-read in the background
    await Lang.store.settle()
    const next = await tr().client()
    expect(next).not.toBe(first)
    expect(next.t.Hello).toBe('Selam')
  })

  it('scans view/js once in production', async () => {
    await tr().client()
    write('view/js/app.js', "Odac.__('New')")
    jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 10000)
    await tr().client()
    expect((await tr().client()).t.Hello).toBe('Merhaba')
  })

  it('picks up view/js changes and collects their keys in debug mode', async () => {
    mockOdac.Config.debug = true
    jest.spyOn(console, 'error').mockImplementation(() => {})
    await tr().client()
    write('view/js/app.js', "Odac.__('Hello'); Odac.__('Brand new')")
    jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 3000)
    await tr().client() // starts the re-scan
    await new Promise(resolve => setTimeout(resolve, 50))
    await tr().client()
    await Lang.store.flush()
    expect(readLang('en')['Brand new']).toBe('Brand new')
    expect(readLang('tr')['Brand new']).toBe('')
  })
})
