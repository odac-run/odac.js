const fs = require('fs')
const os = require('os')
const path = require('path')

// Request-path writes (sessions, form records, CSRF tokens) are queued asynchronously so they
// never block the event loop on a disk commit. They must still be readable immediately by the
// same process, and must not be lost on shutdown.

describe('OdacStorage writes', () => {
  let tmpDir
  let Storage

  const open = () => {
    jest.isolateModules(() => {
      Storage = require('../../src/Storage')
    })
    Storage.init()
    return Storage
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'odac-storage-'))
    global.__dir = tmpDir
    open()
  })

  afterEach(async () => {
    await Storage.close()
    delete global.__dir
    fs.rmSync(tmpDir, {recursive: true, force: true})
  })

  it('does not commit synchronously on put() or remove()', () => {
    const putSync = jest.spyOn(Storage.db, 'putSync')
    const removeSync = jest.spyOn(Storage.db, 'removeSync')

    Storage.put('sess:a', {x: 1})
    Storage.remove('sess:a')

    expect(putSync).not.toHaveBeenCalled()
    expect(removeSync).not.toHaveBeenCalled()
  })

  it('reads its own writes before they are committed', () => {
    Storage.put('sess:a', {x: 1})
    expect(Storage.get('sess:a')).toEqual({x: 1})

    Storage.put('sess:a', {x: 2})
    expect(Storage.get('sess:a')).toEqual({x: 2})

    Storage.remove('sess:a')
    expect(Storage.get('sess:a')).toBeNull()
  })

  it('commits queued writes to the database', async () => {
    Storage.put('sess:b', 'value')
    Storage.put('sess:c', 'gone')
    Storage.remove('sess:c')
    await Storage.flushed()
    // Let the write promises settle so the pending map hands reads back to LMDB.
    await new Promise(resolve => setImmediate(resolve))

    expect(Storage.db.get('sess:b')).toBe('value')
    expect(Storage.db.get('sess:c')).toBeUndefined()
    expect(Storage.get('sess:b')).toBe('value')
  })

  it('keeps the latest value when writes to one key overlap', async () => {
    Storage.put('sess:d', 1)
    Storage.put('sess:d', 2)
    await Storage.flushed()
    await new Promise(resolve => setImmediate(resolve))

    expect(Storage.get('sess:d')).toBe(2)
  })

  it('commits pending writes on close()', async () => {
    Storage.put('sess:e', 'persisted')
    await Storage.close()

    open()
    expect(Storage.get('sess:e')).toBe('persisted')
  })

  it('makes putSync() writes visible to range reads at once', () => {
    Storage.putSync('wb:c:key', {delta: 1})
    expect([...Storage.getKeys({start: 'wb:c:', end: 'wb:c:~'})]).toEqual(['wb:c:key'])

    Storage.removeSync('wb:c:key')
    expect([...Storage.getKeys({start: 'wb:c:', end: 'wb:c:~'})]).toEqual([])
  })
})
