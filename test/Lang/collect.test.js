const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const Ipc = require('../../src/Ipc')
const Lang = require('../../src/Lang')
const Runtime = require('../../src/Lang/Runtime')

// Collected keys are written to every language file at once, in a fixed order, through a
// cluster-wide lock, so files never drift apart.
describe('Lang key collection', () => {
  let tmpDir
  let langDir
  let mockOdac

  const writeLang = (code, data) => fs.writeFileSync(path.join(langDir, `${code}.json`), JSON.stringify(data))
  const readLang = code => JSON.parse(fs.readFileSync(path.join(langDir, `${code}.json`), 'utf8'))
  const readRaw = code => fs.readFileSync(path.join(langDir, `${code}.json`), 'utf8')

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'odac-lang-collect-'))
    langDir = path.join(tmpDir, 'storage/language')
    fs.mkdirSync(langDir, {recursive: true})
    global.__dir = tmpDir
    Lang.store.reset()
    mockOdac = {
      Config: {debug: true, lang: {default: 'en'}},
      Var: val => ({is: type => type === 'alpha' && /^[a-zA-Z]+$/.test(val)}),
      Request: {header: () => null}
    }
    jest.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    Lang.store.reset()
    jest.restoreAllMocks()
    fs.rmSync(tmpDir, {recursive: true, force: true})
  })

  it('writes a key collected in one language to every language file', async () => {
    writeLang('en', {Zebra: 'Zebra'})
    writeLang('tr', {Zebra: 'Zebra'})
    writeLang('de', {})
    await Lang.store.init()
    const lang = new Lang(mockOdac)
    lang.set('tr')
    await lang.get('Apple')
    await Lang.store.flush()

    expect(readRaw('en')).toBe(`${JSON.stringify({Apple: 'Apple', Zebra: 'Zebra'}, null, 4)}\n`)
    expect(readRaw('tr')).toBe(`${JSON.stringify({Apple: '', Zebra: 'Zebra'}, null, 4)}\n`)
    expect(readRaw('de')).toBe(`${JSON.stringify({Apple: '', Zebra: ''}, null, 4)}\n`)
  })

  it('creates the files of languages listed in lang.supported', async () => {
    mockOdac.Config.lang.supported = ['tr']
    await new Lang(mockOdac).get('Hello')
    await Lang.store.flush()
    expect(readLang('en')).toEqual({Hello: 'Hello'})
    expect(readLang('tr')).toEqual({Hello: ''})
  })

  it('does not collect an entry that exists but is untranslated', async () => {
    writeLang('en', {Hello: 'Hello'})
    writeLang('tr', {Hello: ''})
    await Lang.store.init()
    const lang = new Lang(mockOdac)
    lang.set('tr')
    expect(await lang.get('Hello')).toBe('Hello')
    const before = readRaw('tr')
    await Lang.store.flush()
    expect(readRaw('tr')).toBe(before)
  })

  it('does not collect the same key again while it is waiting to be written', async () => {
    writeLang('en', {})
    writeLang('tr', {})
    await Lang.store.init()
    const tr = new Lang(mockOdac)
    tr.set('tr')
    await Promise.all([tr.get('a'), new Lang(mockOdac).get('a'), tr.get('a')])
    await Lang.store.flush()
    expect(readLang('en')).toEqual({a: 'a'})
    expect(readLang('tr')).toEqual({a: ''})
  })

  it('writes through the cluster-wide lock when Ipc is running', async () => {
    writeLang('en', {})
    await Lang.store.init()
    const original = Ipc.initialized
    Ipc.initialized = true
    const lock = jest.spyOn(Ipc, 'lock').mockResolvedValueOnce(false).mockResolvedValue(true)
    const unlock = jest.spyOn(Ipc, 'unlock').mockResolvedValue(true)
    try {
      await new Lang(mockOdac).get('Hello')
      await Lang.store.flush() // lock held elsewhere: nothing written, retried later
      expect(fs.readFileSync(path.join(langDir, 'en.json'), 'utf8')).toBe('{}')
      await Lang.store.flush()
      expect(readLang('en')).toEqual({Hello: 'Hello'})
      expect(lock).toHaveBeenCalledWith('odac:lang:write', 10, expect.any(String))
      expect(unlock).toHaveBeenCalledWith('odac:lang:write', lock.mock.calls[1][2])
    } finally {
      Ipc.initialized = original
    }
  })

  it('leaves an invalid language file untouched and says so', async () => {
    writeLang('en', {})
    fs.writeFileSync(path.join(langDir, 'tr.json'), '{"broken": ')
    await Lang.store.init()
    await new Lang(mockOdac).get('Hello')
    await Lang.store.flush()
    expect(readRaw('tr')).toBe('{"broken": ')
    expect(readLang('en')).toEqual({Hello: 'Hello'})
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('"lang":"tr"'))
  })

  it('warns once per missing translation in debug mode', async () => {
    writeLang('en', {Hello: 'Hello'})
    writeLang('tr', {Hello: ''})
    await Lang.store.init()
    const lang = new Lang(mockOdac)
    lang.set('tr')
    await lang.get('Hello')
    await lang.get('Hello')
    const warnings = console.error.mock.calls.filter(([line]) => line.includes('Missing translation'))
    expect(warnings).toHaveLength(1)
    expect(JSON.parse(warnings[0][0])).toEqual({level: 'WARN', message: 'Missing translation', lang: 'tr', key: 'Hello'})
  })

  it('does not warn for the default language or outside debug mode', async () => {
    writeLang('en', {})
    writeLang('tr', {})
    await Lang.store.init()
    await new Lang(mockOdac).get('Hello')
    mockOdac.Config.debug = false
    const tr = new Lang(mockOdac)
    tr.set('tr')
    await tr.get('Other')
    expect(console.error.mock.calls.filter(([line]) => line.includes('Missing translation'))).toHaveLength(0)
  })

  it('marks text served from the fallback when lang.highlightMissing is on', async () => {
    writeLang('en', {Hello: 'Hello %s1'})
    writeLang('tr', {Hello: '', Bye: 'Güle güle'})
    await Lang.store.init()
    mockOdac.Config.lang.highlightMissing = true
    const lang = new Lang(mockOdac)
    lang.set('tr')
    expect(await lang.get('Hello', 'Emre')).toBe('⟦Hello Emre⟧')
    expect(await lang.get('Bye')).toBe('Güle güle')

    mockOdac.Config.debug = false
    expect(await lang.get('Hello', 'Emre')).toBe('Hello Emre')
  })

  describe('runtime record', () => {
    const readRecord = () => JSON.parse(fs.readFileSync(Runtime.file(tmpDir), 'utf8'))

    it('records every entry looked up, translated or not, with the day', async () => {
      writeLang('en', {'status.ok': 'OK'})
      await Lang.store.init()
      const lang = new Lang(mockOdac)
      await lang.get('status.ok')
      await lang.getx('Gül', 'verb')
      await lang.get('status.ok')
      await Lang.store.flush()
      const today = Runtime.today()
      expect(readRecord()).toEqual({Gül: {verb: today}, 'status.ok': today})
    })

    it('records nothing when key collection is off', async () => {
      writeLang('en', {Hello: 'Hello'})
      mockOdac.Config.debug = false
      await Lang.store.init()
      await new Lang(mockOdac).get('Hello')
      await Lang.store.flush()
      expect(fs.existsSync(Runtime.file(tmpDir))).toBe(false)

      mockOdac.Config.lang.collect = true
      await new Lang(mockOdac).get('Hello')
      await Lang.store.flush()
      expect(readRecord()).toEqual({Hello: Runtime.today()})
    })

    it('writes an entry once a day and adds to what other workers recorded', async () => {
      writeLang('en', {})
      await Runtime.record(tmpDir, [{key: 'Other', context: '', seen: '2026-01-01'}])
      await Lang.store.init()
      const lang = new Lang(mockOdac)
      await lang.get('a')
      await Lang.store.flush()
      expect(readRecord()).toEqual({Other: '2026-01-01', a: Runtime.today()})

      const record = jest.spyOn(Runtime, 'record')
      await lang.get('a')
      await Lang.store.flush()
      expect(record).not.toHaveBeenCalled()
    })

    it('retries an entry whose record could not be written', async () => {
      writeLang('en', {a: 'a'})
      await Lang.store.init()
      const record = jest.spyOn(Runtime, 'record').mockRejectedValueOnce(new Error('disk full'))
      const lang = new Lang(mockOdac)
      await lang.get('a')
      await Lang.store.flush()
      expect(console.error).toHaveBeenCalledWith(expect.stringContaining('disk full'))
      await lang.get('a')
      await Lang.store.flush()
      expect(record).toHaveBeenCalledTimes(2)
      expect(readRecord()).toEqual({a: Runtime.today()})
    })
  })
})
