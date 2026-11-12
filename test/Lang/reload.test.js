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
  // Moves past the recheck interval; a lookup notices it and the file is re-checked in the
  // background, while that lookup is still served the version in memory.
  const recheck = async (code = 'tr') => {
    clock += 3000
    Lang.store.load(code)
    await Lang.store.settle()
  }
  // Rewrites a file with a later mtime and lets the store re-check it.
  const edit = async (code, content) => {
    fs.writeFileSync(file(code), typeof content === 'string' ? content : JSON.stringify(content))
    const mtime = new Date(clock + 3000)
    fs.utimesSync(file(code), mtime, mtime)
    await recheck(code)
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
    expect(tr().get('Hello')).toBe('Merhaba')
    await edit('tr', {Hello: 'Selam'})
    expect(tr().get('Hello')).toBe('Selam')
  })

  it('serves the version in memory to the lookup that notices the edit, the new one after', async () => {
    fs.writeFileSync(file('tr'), JSON.stringify({Hello: 'Selam'}))
    const mtime = new Date(clock + 3000)
    fs.utimesSync(file('tr'), mtime, mtime)
    clock += 3000
    const readFile = jest.spyOn(fs.promises, 'readFile')
    expect(tr().get('Hello')).toBe('Merhaba')
    expect(tr().get('Hello')).toBe('Merhaba')
    await Lang.store.settle()
    expect(readFile).toHaveBeenCalledTimes(1)
    expect(tr().get('Hello')).toBe('Selam')
  })

  it('keeps the last valid translations while the file is not valid JSON', async () => {
    expect(await tr().get('Hello')).toBe('Merhaba')
    await edit('tr', '{"Hello": "Sel')
    expect(await tr().get('Hello')).toBe('Merhaba')
    expect(warnings).toEqual([{level: 'WARN', message: 'Language file is not valid JSON; serving its last valid version', lang: 'tr'}])
  })

  it('warns once per version of a broken file and recovers when it is fixed', async () => {
    await tr().get('Hello')
    await edit('tr', '[1, 2]')
    await tr().get('Hello')
    await recheck()
    await tr().get('Hello')
    expect(warnings).toHaveLength(1)

    await edit('tr', '{broken')
    await tr().get('Hello')
    expect(warnings).toHaveLength(2)

    await edit('tr', {Hello: 'Selam'})
    expect(await tr().get('Hello')).toBe('Selam')
    expect(warnings).toHaveLength(2)
  })

  it('reads a broken file again even when the fixed one keeps its mtime', async () => {
    await tr().get('Hello')
    await edit('tr', '{"Hello": "Sel')
    await tr().get('Hello')
    // The rest of the upload lands within the same mtime tick.
    const {mtime} = fs.statSync(file('tr'))
    fs.writeFileSync(file('tr'), JSON.stringify({Hello: 'Selam'}))
    fs.utimesSync(file('tr'), mtime, mtime)
    await recheck()
    expect(await tr().get('Hello')).toBe('Selam')
  })

  it('keeps the last valid translations when the file cannot be read', async () => {
    await tr().get('Hello')
    fs.rmSync(file('tr'))
    fs.mkdirSync(file('tr'))
    await recheck()
    expect(await tr().get('Hello')).toBe('Merhaba')
    expect(warnings).toEqual([
      expect.objectContaining({message: 'Language file could not be read; serving its last valid version', lang: 'tr'})
    ])
  })

  it('serves keys untranslated when the file is deleted', async () => {
    await tr().get('Hello')
    fs.rmSync(file('tr'))
    await recheck()
    expect(await tr().get('Hello')).toBe('Hello')
    expect(warnings).toEqual([])
  })

  it('identifies browser translations by content, so an edit changes their version', async () => {
    fs.mkdirSync(path.join(root, 'view/js'), {recursive: true})
    fs.writeFileSync(path.join(root, 'view/js/app.js'), "Odac.__('Hello')")
    const first = await tr().client()
    expect(first.v).toMatch(/^[\w-]{16}$/)

    await recheck()
    expect((await tr().client()).v).toBe(first.v)

    await edit('tr', {Hello: 'Selam'})
    const next = await tr().client()
    expect(next.t.Hello).toBe('Selam')
    expect(next.v).not.toBe(first.v)

    await edit('tr', '{broken')
    expect((await tr().client()).v).toBe(next.v)
  })
})
