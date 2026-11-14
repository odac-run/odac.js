const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const Lang = require('../../src/Lang')

// Translations are source files: they live in lang/ (or lang.path), outside the git-ignored
// storage/. Projects that still keep them in storage/language/ keep working, with a warning.
describe('Lang language directory', () => {
  let root
  let mockOdac
  let warnings

  const write = (file, content) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), {recursive: true})
    fs.writeFileSync(path.join(root, file), JSON.stringify(content))
  }
  const read = file => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'))
  const tr = () => {
    const lang = new Lang(mockOdac)
    lang.set('tr')
    return lang
  }

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'odac-lang-directory-'))
    global.__dir = root
    Lang.store.reset()
    warnings = []
    jest.spyOn(console, 'error').mockImplementation(line => warnings.push(JSON.parse(line)))
    mockOdac = {
      Config: {debug: false, lang: {default: 'en'}},
      Request: {header: () => null}
    }
  })

  afterEach(() => {
    Lang.store.reset()
    jest.restoreAllMocks()
    fs.rmSync(root, {recursive: true, force: true})
  })

  it('reads language files from lang/', async () => {
    write('lang/tr.json', {Hello: 'Merhaba'})
    await Lang.store.init(mockOdac.Config)
    expect(tr().get('Hello')).toBe('Merhaba')
    expect(warnings).toEqual([])
  })

  it('reads language files from lang.path, relative to the project root', async () => {
    mockOdac.Config.lang.path = 'resources/i18n'
    write('resources/i18n/tr.json', {Hello: 'Merhaba'})
    write('lang/tr.json', {Hello: 'Not this one'})
    await Lang.store.init(mockOdac.Config)
    expect(tr().get('Hello')).toBe('Merhaba')
  })

  it('reads language files from an absolute lang.path', async () => {
    const shared = fs.mkdtempSync(path.join(os.tmpdir(), 'odac-lang-shared-'))
    try {
      fs.writeFileSync(path.join(shared, 'tr.json'), JSON.stringify({Hello: 'Merhaba'}))
      mockOdac.Config.lang.path = shared
      await Lang.store.init(mockOdac.Config)
      expect(tr().get('Hello')).toBe('Merhaba')
    } finally {
      fs.rmSync(shared, {recursive: true, force: true})
    }
  })

  it('still reads storage/language/ when lang/ does not exist, and warns once', async () => {
    write('storage/language/tr.json', {Hello: 'Merhaba'})
    await Lang.store.init(mockOdac.Config)
    expect(tr().get('Hello')).toBe('Merhaba')
    expect(tr().get('Hello')).toBe('Merhaba')
    await Lang.store.settle()
    const deprecated = warnings.filter(w => w.message.includes('storage/language/'))
    expect(deprecated).toHaveLength(1)
    expect(deprecated[0].level).toBe('WARN')
  })

  it('writes collected keys to storage/language/ while it is the directory in use', async () => {
    mockOdac.Config.debug = true
    write('storage/language/en.json', {})
    write('storage/language/tr.json', {})
    await Lang.store.init(mockOdac.Config)
    tr().get('Collected')
    await Lang.store.flush()
    expect(read('storage/language/tr.json')).toEqual({Collected: ''})
    expect(fs.existsSync(path.join(root, 'lang'))).toBe(false)
  })

  it('creates lang/ for collected keys in a project without language files', async () => {
    mockOdac.Config.debug = true
    await Lang.store.init(mockOdac.Config)
    new Lang(mockOdac).get('Hello')
    await Lang.store.flush()
    expect(read('lang/en.json')).toEqual({Hello: 'Hello'})
    expect(fs.existsSync(path.join(root, 'storage', 'language'))).toBe(false)
  })

  it('warns once about a lang.path that is not a string and uses lang/', async () => {
    mockOdac.Config.lang.path = 42
    write('lang/tr.json', {Hello: 'Merhaba'})
    await Lang.store.init(mockOdac.Config)
    expect(tr().get('Hello')).toBe('Merhaba')
    expect(warnings.filter(w => w.message.includes('lang.path'))).toHaveLength(1)
  })
})
