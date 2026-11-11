'use strict'

const cluster = require('node:cluster')

/**
 * WriteBuffer failure handling: a row the database rejects must not block its queue, a failed
 * flush must keep its checkpoint, the flush lock must only be released by its holder, and
 * cached counter bases must not go stale forever.
 */

let knexLib, db, WriteBuffer, Ipc, storageData

const mockStorage = () => ({
  isReady: () => true,
  getRange: ({start, end}) =>
    [...storageData.entries()].filter(([key]) => key >= start && key <= end).map(([key, value]) => ({key, value})),
  putSync: (key, value) => storageData.set(key, value),
  removeSync: key => storageData.delete(key),
  transactionSync: callback => callback()
})

beforeEach(async () => {
  jest.resetModules()
  storageData = new Map()
  knexLib = require('knex')
  db = knexLib({client: 'sqlite3', connection: {filename: ':memory:'}, useNullAsDefault: true})
  await db.schema.createTable('events', t => {
    t.increments('id')
    t.string('type').notNullable()
  })
  await db.schema.createTable('posts', t => {
    t.integer('id').primary()
    t.integer('views').defaultTo(0)
    t.string('title')
  })
  await db('posts').insert({id: 1, views: 100, title: 'a'})

  Object.defineProperty(cluster, 'isPrimary', {value: true, configurable: true})
  Ipc = require('../../../src/Ipc')
  global.Odac = {Config: {buffer: {flushInterval: 999999, checkpointInterval: 999999}}, Storage: mockStorage(), Ipc}
  await Ipc.init()
  WriteBuffer = require('../../../src/Database/WriteBuffer')
  await WriteBuffer.init({default: db})
  jest.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(async () => {
  jest.restoreAllMocks()
  await WriteBuffer.close()
  await Ipc.close()
  await db.destroy()
  delete global.Odac
})

describe('WriteBuffer - poison rows', () => {
  it('inserts the good rows of a batch that contains a rejected row', async () => {
    await WriteBuffer.insert('default', 'events', {type: 'a'})
    await WriteBuffer.insert('default', 'events', {type: null})
    await WriteBuffer.insert('default', 'events', {type: 'b'})

    await WriteBuffer.flush()

    expect((await db('events').select('type')).map(r => r.type).sort()).toEqual(['a', 'b'])
    const queued = await Ipc.lrange('wb:q:default:events', 0, -1)
    expect(queued).toHaveLength(1)
  })

  it('moves a row to the dead-letter list after maxInsertAttempts cycles', async () => {
    await WriteBuffer.insert('default', 'events', {type: null})

    for (let i = 0; i < 3; i++) await WriteBuffer.flush()

    expect(await Ipc.lrange('wb:q:default:events', 0, -1)).toHaveLength(0)
    const dead = await WriteBuffer.deadLetters('default', 'events')
    expect(dead).toHaveLength(1)
    expect(dead[0].row).toEqual({type: null})
    expect(dead[0].error).toMatch(/NOT NULL/i)

    const DB = require('../../../src/Database')
    DB.connections = {default: db}
    db._odacConnectionKey = 'default'
    DB._nanoidColumns = {}
    expect(await DB.events.buffer.deadLetters()).toHaveLength(1)

    // The queue is no longer blocked.
    await WriteBuffer.insert('default', 'events', {type: 'later'})
    await WriteBuffer.flush()
    expect(await db('events').where('type', 'later')).toHaveLength(1)
  })

  it('does not use up attempts while the database is unreachable', async () => {
    await WriteBuffer.insert('default', 'missing_table', {type: 'x'})
    jest.spyOn(WriteBuffer, '_reachable').mockResolvedValue(false)

    for (let i = 0; i < 5; i++) await WriteBuffer.flush()

    expect(await Ipc.lrange('wb:q:default:missing_table', 0, -1)).toHaveLength(1)
    expect(await WriteBuffer.deadLetters('default', 'missing_table')).toHaveLength(0)
  })

  it('starts at most one auto-flush at a time per process', async () => {
    WriteBuffer._config.maxQueueSize = 1
    let release
    const flushQueues = jest.spyOn(WriteBuffer, '_flushQueues').mockImplementation(() => new Promise(resolve => (release = resolve)))

    for (let i = 0; i < 5; i++) await WriteBuffer.insert('default', 'events', {type: 'x'})

    expect(flushQueues).toHaveBeenCalledTimes(1)
    release()
  })
})

describe('WriteBuffer - checkpoint', () => {
  it('keeps the checkpoint of a group whose flush failed and drops the one that succeeded', async () => {
    await WriteBuffer.increment('default', 'posts', 1, 'views', 5)
    await WriteBuffer.update('default', 'posts', 1, {no_such_column: 'x'})
    await WriteBuffer._writeCheckpoint()
    expect([...storageData.keys()].sort()).toEqual(['wb:c:default:posts:1:views', 'wb:u:default:posts:1'])

    await WriteBuffer.flush()

    expect(storageData.has('wb:c:default:posts:1:views')).toBe(false)
    expect(storageData.has('wb:u:default:posts:1')).toBe(true)
  })

  it('rewrites a queue checkpoint so rows already inserted are not replayed', async () => {
    await WriteBuffer.insert('default', 'events', {type: 'ok'})
    await WriteBuffer.insert('default', 'events', {type: null})
    await WriteBuffer._writeCheckpoint()
    expect(storageData.get('wb:q:default:events')).toHaveLength(2)

    await WriteBuffer.flush()

    const checkpoint = storageData.get('wb:q:default:events')
    expect(checkpoint).toHaveLength(1)
    expect(checkpoint[0].row).toEqual({type: null})
  })

  it('removes checkpoint entries that are no longer pending when it is rewritten', async () => {
    storageData.set('wb:u:default:posts:99', {title: 'stale'})
    await WriteBuffer._writeCheckpoint()
    expect(storageData.has('wb:u:default:posts:99')).toBe(false)
  })

  it('checkpoints at half the flush interval by default', async () => {
    await WriteBuffer.close()
    jest.resetModules()
    global.Odac.Config.buffer = {flushInterval: 5000}
    const fresh = require('../../../src/Database/WriteBuffer')
    await fresh.init({default: db})
    expect(fresh._config.checkpointInterval).toBe(2500)
    await fresh.close()
  })
})

describe('WriteBuffer - flush lock', () => {
  it('does not flush or release a lock held by another process', async () => {
    await WriteBuffer.increment('default', 'posts', 1, 'views', 5)
    await Ipc.lock('wb:lock:flush', 10, 'someone-else')

    await WriteBuffer.flush()

    expect((await db('posts').where('id', 1).first()).views).toBe(100)
    expect(await Ipc.lock('wb:lock:flush', 10, 'third')).toBe(false)
  })

  it('releases its own lock after flushing', async () => {
    await WriteBuffer.flush()
    expect(await Ipc.lock('wb:lock:flush', 10, 'next')).toBe(true)
  })
})

describe('WriteBuffer - counter base', () => {
  it('re-reads the base after a flush so outside changes become visible', async () => {
    await WriteBuffer.increment('default', 'posts', 1, 'views', 5)
    await WriteBuffer.flush()
    await db('posts').where('id', 1).update({views: 1000})

    expect(await WriteBuffer.get('default', 'posts', 1, 'views')).toBe(1000)
  })

  it('caches the base with a ttl', async () => {
    await WriteBuffer.get('default', 'posts', 1, 'views')
    await db('posts').where('id', 1).update({views: 7})
    expect(await WriteBuffer.get('default', 'posts', 1, 'views')).toBe(100)

    const now = Date.now()
    jest.spyOn(Date, 'now').mockReturnValue(now + 301_000)
    expect(await WriteBuffer.get('default', 'posts', 1, 'views')).toBe(7)
  })
})
