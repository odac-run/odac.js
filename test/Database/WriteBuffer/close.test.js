'use strict'

const cluster = require('node:cluster')

/**
 * Tests WriteBuffer.close(), the final flush on graceful shutdown.
 * Why: buffered writes live in the IPC store until flushed. If the store is
 * torn down first, the final flush sees nothing, reports success and clears
 * the LMDB checkpoint, silently dropping every write since the last flush.
 */

let knexLib, db, WriteBuffer, Ipc

beforeEach(async () => {
  jest.resetModules()

  knexLib = require('knex')
  db = knexLib({client: 'sqlite3', connection: {filename: ':memory:'}, useNullAsDefault: true})

  await db.schema.createTable('posts', table => {
    table.integer('id').primary()
    table.integer('views').defaultTo(0)
    table.string('title', 255)
  })
  await db('posts').insert({id: 1, views: 100, title: 'First'})

  Object.defineProperty(cluster, 'isPrimary', {value: true, configurable: true})

  Ipc = require('../../../src/Ipc')
  global.Odac = {
    Config: {buffer: {flushInterval: 999999, checkpointInterval: 999999}},
    Storage: {
      isReady: () => true,
      putSync: jest.fn(),
      removeSync: jest.fn(),
      getRange: jest.fn(() => [])
    },
    Ipc
  }
  await Ipc.init()

  WriteBuffer = require('../../../src/Database/WriteBuffer')
  await WriteBuffer.init({default: db})
  jest.spyOn(console, 'log').mockImplementation(() => {})
  jest.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(async () => {
  await Ipc.close()
  await db.destroy()
  jest.restoreAllMocks()
  delete global.Odac
})

describe('WriteBuffer.close()', () => {
  it('writes buffered inserts and counters to the database', async () => {
    await WriteBuffer.insert('default', 'posts', {id: 2, views: 0, title: 'Second'})
    await WriteBuffer.increment('default', 'posts', 1, 'views', 5)

    await WriteBuffer.close()

    const rows = await db('posts').orderBy('id')
    expect(rows.map(r => r.id)).toEqual([1, 2])
    expect(rows[0].views).toBe(105)
  })

  it('keeps the checkpoint when IPC was closed before the final flush', async () => {
    await WriteBuffer.increment('default', 'posts', 1, 'views', 5)
    Odac.Storage.getRange.mockImplementation(({start}) => (start === 'wb:c:' ? [{key: 'wb:c:default:posts:1:views'}] : []))
    await Ipc.close()

    await WriteBuffer.close()

    expect(Odac.Storage.removeSync).not.toHaveBeenCalled()
    expect(console.error).toHaveBeenCalled()
    expect(console.log).not.toHaveBeenCalledWith(expect.stringContaining('Final flush completed'))
  })
})
