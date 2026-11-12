const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const Runtime = require('../../src/Lang/Runtime')

describe('Lang runtime record', () => {
  let root

  const readRaw = () => JSON.parse(fs.readFileSync(Runtime.file(root), 'utf8'))

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'odac-lang-runtime-'))
  })

  afterEach(() => {
    fs.rmSync(root, {recursive: true, force: true})
  })

  it('lives in storage/.cache, which git ignores', () => {
    expect(Runtime.file(root)).toBe(path.join(root, 'storage', '.cache', 'lang-runtime.json'))
  })

  it('reports today as a UTC day', () => {
    expect(Runtime.today()).toBe(new Date().toISOString().slice(0, 10))
  })

  it('reads nothing when there is no record or it is not JSON', async () => {
    expect((await Runtime.read(root)).size).toBe(0)
    fs.mkdirSync(path.dirname(Runtime.file(root)), {recursive: true})
    fs.writeFileSync(Runtime.file(root), '{nope')
    expect((await Runtime.read(root)).size).toBe(0)
  })

  it('records entries in the language file layout, sorted', async () => {
    await Runtime.record(root, [
      {key: 'status.ok', context: '', seen: '2026-11-10'},
      {key: 'Gül', context: 'verb', seen: '2026-11-11'}
    ])
    expect(readRaw()).toEqual({Gül: {verb: '2026-11-11'}, 'status.ok': '2026-11-10'})
    expect(Object.keys(readRaw())).toEqual(['Gül', 'status.ok'])
    const recorded = await Runtime.read(root)
    expect(recorded.get('Gül\u0000verb')).toEqual({key: 'Gül', context: 'verb', seen: '2026-11-11'})
  })

  it('merges with the record on disk, keeping the later day', async () => {
    await Runtime.record(root, [
      {key: 'a', context: '', seen: '2026-11-10'},
      {key: 'b', context: '', seen: '2026-11-12'}
    ])
    await Runtime.record(root, [
      {key: 'a', context: '', seen: '2026-11-12'},
      {key: 'b', context: '', seen: '2026-11-01'},
      {key: 'c', context: '', seen: '2026-11-12'}
    ])
    expect(readRaw()).toEqual({a: '2026-11-12', b: '2026-11-12', c: '2026-11-12'})
  })

  it('ignores values that are not days', async () => {
    fs.mkdirSync(path.dirname(Runtime.file(root)), {recursive: true})
    fs.writeFileSync(Runtime.file(root), JSON.stringify({a: '2026-11-12', b: 'yesterday', c: 5}))
    expect([...(await Runtime.read(root)).keys()]).toEqual(['a\u0000'])
  })

  it('forgets entries and leaves the file alone when none were recorded', async () => {
    await Runtime.record(root, [
      {key: 'a', context: '', seen: '2026-11-12'},
      {key: 'b', context: 'x', seen: '2026-11-12'}
    ])
    await Runtime.forget(root, [{key: 'b', context: 'x'}])
    expect(readRaw()).toEqual({a: '2026-11-12'})

    const before = fs.statSync(Runtime.file(root)).mtimeMs
    await Runtime.forget(root, [{key: 'missing', context: ''}])
    expect(fs.statSync(Runtime.file(root)).mtimeMs).toBe(before)
  })
})
