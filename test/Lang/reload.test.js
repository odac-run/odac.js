const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const Lang = require('../../src/Lang')

// Language files edited while the app runs (by hand, an upload or a panel) are picked up on
// the next check, and a broken or half-written file never wipes the translations served.
describe('Lang language file reload', () => {
  let root
  let langDir
  let mockOdac
  let clock
  let warnings

  const file = code => path.join(langDir, `${code}.json`)
  // Rewrites a file with a later mtime and moves past the recheck interval.
  const edit = (code, content) => {
    fs.writeFileSync(file(code), typeof content === 'string' ? content : JSON.stringify(content))
    clock += 3000
    const mtime = new Date(clock)
    fs.utimesSync(file(code), mtime, mtime)
  }
  const tr = () => {
    const lang = new Lang(mockOdac)
    lang.set('tr')
    return lang
  }

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'odac-lang-reload-'))
    langDir = path.join(root, 'storage/language')
    fs.mkdirSync(langDir, {recursive: true})
    global.__dir = root
    Lang.store.reset()
    Lang.frontendKeys.reset()
    clock = Date.now()
    jest.spyOn(Date, 'now').mockImplementation(() => clock)
    warnings = []
    jest.spyOn(console, 'error').mockImplementation(line => warnings.push(JSON.parse(line)))
    mockOdac = {
      Config: {debug: false, lang: {default: 'en'}},
      Var: val => ({is: type => type === 'alpha' && /^[a-zA-Z]+$/.test(val)}),
      Request: {header: () => null}
    }
    fs.writeFileSync(file('en'), JSON.stringify({Hello: 'Hello'}))
    fs.writeFileSync(file('tr'), JSON.stringify({Hello: 'Merhaba'}))
    await Lang.store.init()
  })

  afterEach(() => {
    Lang.store.reset()
    Lang.frontendKeys.reset()
    jest.restoreAllMocks()
    fs.rmSync(root, {recursive: true, force: true})
  })

  it('serves a file edited on disk without a restart', async () => {
    expect(await tr().get('Hello')).toBe('Merhaba')
    edit('tr', {Hello: 'Selam'})
    expect(await tr().get('Hello')).toBe('Selam')
  })

  it('keeps the last valid translations while the file is not valid JSON', async () => {
    expect(await tr().get('Hello')).toBe('Merhaba')
    edit('tr', '{"Hello": "Sel')
    expect(await tr().get('Hello')).toBe('Merhaba')
    expect(warnings).toEqual([{level: 'WARN', message: 'Language file is not valid JSON; serving its last valid version', lang: 'tr'}])
  })

  it('warns once per version of a broken file and recovers when it is fixed', async () => {
    await tr().get('Hello')
    edit('tr', '[1, 2]')
    await tr().get('Hello')
    clock += 3000
    await tr().get('Hello')
    expect(warnings).toHaveLength(1)

    edit('tr', '{broken')
    await tr().get('Hello')
    expect(warnings).toHaveLength(2)

    edit('tr', {Hello: 'Selam'})
    expect(await tr().get('Hello')).toBe('Selam')
    expect(warnings).toHaveLength(2)
  })

  it('reads a broken file again even when the fixed one keeps its mtime', async () => {
    await tr().get('Hello')
    edit('tr', '{"Hello": "Sel')
    await tr().get('Hello')
    // The rest of the upload lands within the same mtime tick.
    const {mtime} = fs.statSync(file('tr'))
    fs.writeFileSync(file('tr'), JSON.stringify({Hello: 'Selam'}))
    fs.utimesSync(file('tr'), mtime, mtime)
    clock += 3000
    expect(await tr().get('Hello')).toBe('Selam')
  })

  it('keeps the last valid translations when the file cannot be read', async () => {
    await tr().get('Hello')
    fs.rmSync(file('tr'))
    fs.mkdirSync(file('tr'))
    clock += 3000
    expect(await tr().get('Hello')).toBe('Merhaba')
    expect(warnings).toEqual([
      expect.objectContaining({message: 'Language file could not be read; serving its last valid version', lang: 'tr'})
    ])
  })

  it('serves keys untranslated when the file is deleted', async () => {
    await tr().get('Hello')
    fs.rmSync(file('tr'))
    clock += 3000
    expect(await tr().get('Hello')).toBe('Hello')
    expect(warnings).toEqual([])
  })

  it('identifies browser translations by content, so an edit changes their version', async () => {
    fs.mkdirSync(path.join(root, 'view/js'), {recursive: true})
    fs.writeFileSync(path.join(root, 'view/js/app.js'), "Odac.__('Hello')")
    const first = await tr().client()
    expect(first.v).toMatch(/^[\w-]{16}$/)

    clock += 3000
    expect((await tr().client()).v).toBe(first.v)

    edit('tr', {Hello: 'Selam'})
    const next = await tr().client()
    expect(next.t.Hello).toBe('Selam')
    expect(next.v).not.toBe(first.v)

    edit('tr', '{broken')
    expect((await tr().client()).v).toBe(next.v)
  })
})
