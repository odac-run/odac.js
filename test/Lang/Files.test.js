const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const Files = require('../../src/Lang/Files')

describe('Lang Files.sync()', () => {
  let dir

  const write = (code, content) =>
    fs.writeFileSync(path.join(dir, `${code}.json`), typeof content === 'string' ? content : JSON.stringify(content))
  const read = code => fs.readFileSync(path.join(dir, `${code}.json`), 'utf8')

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'odac-lang-files-'))
  })

  afterEach(() => {
    fs.rmSync(dir, {recursive: true, force: true})
  })

  it('gives every language the same entries in the same order', async () => {
    write('en', {Zebra: 'Zebra', Apple: 'Apple'})
    write('tr', {Login: 'Giriş', Apple: 'Elma'})

    const result = await Files.sync(dir, {languages: ['en', 'tr'], defaultLanguage: 'en'})

    expect(result.written).toEqual(['en', 'tr'])
    expect(result.added).toEqual({en: 1, tr: 1})
    expect(read('en')).toBe(`${JSON.stringify({Apple: 'Apple', Login: 'Login', Zebra: 'Zebra'}, null, 4)}\n`)
    expect(read('tr')).toBe(`${JSON.stringify({Apple: 'Elma', Login: 'Giriş', Zebra: ''}, null, 4)}\n`)
  })

  it('adds new entries with the key in the default language and "" elsewhere', async () => {
    write('en', {})
    await Files.sync(dir, {
      languages: ['en', 'tr', 'de'],
      defaultLanguage: 'en',
      add: [
        {key: 'Gül', context: 'verb'},
        {key: 'Hello', context: ''}
      ]
    })
    expect(JSON.parse(read('en'))).toEqual({Gül: {verb: 'Gül'}, Hello: 'Hello'})
    expect(JSON.parse(read('tr'))).toEqual({Gül: {verb: ''}, Hello: ''})
    expect(JSON.parse(read('de'))).toEqual({Gül: {verb: ''}, Hello: ''})
  })

  it('keeps existing translations and merges contexts into the same key', async () => {
    write('en', {Gül: 'Rose'})
    write('tr', {Gül: {flower: 'Gül'}})
    await Files.sync(dir, {languages: ['en', 'tr'], defaultLanguage: 'tr', add: [{key: 'Gül', context: 'verb'}]})
    expect(JSON.parse(read('en'))).toEqual({Gül: {'': 'Rose', flower: '', verb: ''}})
    expect(JSON.parse(read('tr'))).toEqual({Gül: {'': 'Gül', flower: 'Gül', verb: 'Gül'}})
  })

  it('removes entries from every file', async () => {
    write('en', {a: 'A', b: 'B', c: {x: 'X', y: 'Y'}})
    write('tr', {a: 'A', b: 'Bé', c: {x: 'X'}})
    const result = await Files.sync(dir, {
      languages: ['en', 'tr'],
      defaultLanguage: 'en',
      remove: [
        {key: 'b', context: ''},
        {key: 'c', context: 'y'},
        {key: 'missing', context: ''}
      ]
    })
    expect(result.removed).toBe(2)
    expect(JSON.parse(read('en'))).toEqual({a: 'A', c: {x: 'X'}})
    expect(JSON.parse(read('tr'))).toEqual({a: 'A', c: {x: 'X'}})
  })

  it('does not rewrite files that are already in sync', async () => {
    write('en', {a: 'A'})
    await Files.sync(dir, {languages: ['en'], defaultLanguage: 'en'})
    const {mtimeMs} = fs.statSync(path.join(dir, 'en.json'))
    const result = await Files.sync(dir, {languages: ['en'], defaultLanguage: 'en'})
    expect(result.written).toEqual([])
    expect(fs.statSync(path.join(dir, 'en.json')).mtimeMs).toBe(mtimeMs)
  })

  it('never overwrites a file that is not valid JSON', async () => {
    write('en', {a: 'A'})
    write('tr', '{"a": "A",')
    const result = await Files.sync(dir, {languages: ['en', 'tr'], defaultLanguage: 'en', add: [{key: 'b', context: ''}]})
    expect(result.invalid).toEqual(['tr'])
    expect(read('tr')).toBe('{"a": "A",')
    expect(JSON.parse(read('en'))).toEqual({a: 'A', b: 'b'})
  })

  it('ignores invalid language codes and leaves no temporary files', async () => {
    await Files.sync(dir, {languages: ['en', '../x', 'TR'], defaultLanguage: 'en', add: [{key: 'a', context: ''}]})
    expect(fs.readdirSync(dir)).toEqual(['en.json'])
  })

  it('lists only language files', async () => {
    write('tr', {})
    write('en', {})
    fs.writeFileSync(path.join(dir, 'tr.json.1.tmp'), '')
    fs.writeFileSync(path.join(dir, '.client.json'), '')
    expect(await Files.listLanguages(dir)).toEqual(['en', 'tr'])
    expect(await Files.listLanguages(path.join(dir, 'missing'))).toEqual([])
  })
})

describe('Lang Files.resolveDirectory()', () => {
  let root

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'odac-lang-dir-'))
  })

  afterEach(() => {
    fs.rmSync(root, {recursive: true, force: true})
  })

  it('defaults to lang/ in the project root, even before it exists', async () => {
    expect(await Files.resolveDirectory(root, {})).toEqual({dir: path.join(root, 'lang'), legacy: false, ignored: false})
  })

  it('resolves a relative lang.path against the project root', async () => {
    const result = await Files.resolveDirectory(root, {lang: {path: ' resources/i18n '}})
    expect(result).toEqual({dir: path.join(root, 'resources/i18n'), legacy: false, ignored: false})
  })

  it('keeps an absolute lang.path as it is', async () => {
    const dir = path.join(os.tmpdir(), 'odac-shared-translations')
    expect((await Files.resolveDirectory(root, {lang: {path: dir}})).dir).toBe(dir)
  })

  it('uses storage/language/ when lang/ does not exist', async () => {
    fs.mkdirSync(path.join(root, 'storage', 'language'), {recursive: true})
    expect(await Files.resolveDirectory(root, {})).toEqual({dir: path.join(root, 'storage', 'language'), legacy: true, ignored: false})
  })

  it('prefers lang/ once it exists', async () => {
    fs.mkdirSync(path.join(root, 'storage', 'language'), {recursive: true})
    fs.mkdirSync(path.join(root, 'lang'))
    expect(await Files.resolveDirectory(root, {})).toEqual({dir: path.join(root, 'lang'), legacy: false, ignored: false})
  })

  it('never falls back to storage/language/ when lang.path is set', async () => {
    fs.mkdirSync(path.join(root, 'storage', 'language'), {recursive: true})
    expect(await Files.resolveDirectory(root, {lang: {path: 'i18n'}})).toEqual({
      dir: path.join(root, 'i18n'),
      legacy: false,
      ignored: false
    })
  })

  it('ignores a lang.path that is not a non-empty string and says so', async () => {
    for (const value of ['', '  ', 42, ['lang'], {}]) {
      expect(await Files.resolveDirectory(root, {lang: {path: value}})).toEqual({
        dir: path.join(root, 'lang'),
        legacy: false,
        ignored: true
      })
    }
    expect((await Files.resolveDirectory(root, {lang: {path: null}})).ignored).toBe(false)
  })
})
