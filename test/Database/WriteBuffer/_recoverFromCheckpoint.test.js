'use strict'

const cluster = require('node:cluster')

/**
 * Tests WriteBuffer LMDB checkpoint and crash recovery.
 * Why: Validates zero data loss guarantee — buffered data survives process crashes
 * via periodic LMDB checkpoints and is recovered on next startup.
 */

let knexLib, db, storageData

function createMockStorage() {
  storageData = new Map()
  return {
    isReady: () => true,
    put: (key, value) => storageData.set(key, value),
    remove: key => storageData.delete(key),
    get: key => storageData.get(key) ?? null,
    getRange: ({start, end}) => {
      const results = []
      for (const [key, value] of storageData) {
        if (key >= start && key < end) {
          results.push({key, value})
        }
      }
      return results
    }
  }
}

beforeEach(async () => {
  jest.resetModules()

  knexLib = require('knex')
  db = knexLib({client: 'sqlite3', connection: {filename: ':memory:'}, useNullAsDefault: true})

  await db.schema.createTable('posts', table => {
    table.integer('id').primary()
    table.integer('views').defaultTo(0)
  })
  await db('posts').insert({id: 1, views: 100})

  Object.defineProperty(cluster, 'isPrimary', {value: true, configurable: true})
})

afterEach(async () => {
  await db.destroy()
  delete global.Odac
  delete global.__odac_wb_message_handler
})

describe('WriteBuffer - Checkpoint', () => {
  it('should write counter deltas to LMDB on checkpoint', async () => {
    global.Odac = {
      Config: {buffer: {flushInterval: 999999, checkpointInterval: 999999}},
      Storage: createMockStorage()
    }

    const WriteBuffer = require('../../../src/Database/WriteBuffer')
    await WriteBuffer.init({default: db})

    await WriteBuffer.increment('default', 'posts', 1, 'views', 5)
    WriteBuffer._writeCheckpoint()

    const checkpoint = storageData.get('wb:c:default:posts:1:views')
    expect(checkpoint).toBeDefined()
    expect(checkpoint.delta).toBe(5)
    expect(checkpoint.base).toBe(100)

    await WriteBuffer.close()
  })

  it('should write queue rows to LMDB on checkpoint', async () => {
    global.Odac = {
      Config: {buffer: {flushInterval: 999999, checkpointInterval: 999999}},
      Storage: createMockStorage()
    }

    const WriteBuffer = require('../../../src/Database/WriteBuffer')
    await WriteBuffer.init({default: db})

    WriteBuffer._primaryInsert('default', 'activity_log', {user_id: 1, action: 'view'})
    WriteBuffer._primaryInsert('default', 'activity_log', {user_id: 2, action: 'click'})
    WriteBuffer._writeCheckpoint()

    const checkpoint = storageData.get('wb:q:default:activity_log')
    expect(checkpoint).toBeDefined()
    expect(checkpoint).toHaveLength(2)
    expect(checkpoint[0].action).toBe('view')

    await WriteBuffer.close()
  })
})

describe('WriteBuffer - Recovery', () => {
  it('should recover counter deltas from LMDB on startup', async () => {
    // Simulate crash: write checkpoint data before init
    const mockStorage = createMockStorage()
    storageData.set('wb:c:default:posts:1:views', {delta: 7, base: 100})

    global.Odac = {
      Config: {buffer: {flushInterval: 999999, checkpointInterval: 999999}},
      Storage: mockStorage
    }

    const WriteBuffer = require('../../../src/Database/WriteBuffer')
    await WriteBuffer.init({default: db})

    // Should recover the delta from checkpoint
    const result = await WriteBuffer.get('default', 'posts', 1, 'views')
    expect(result).toBe(107) // base 100 + recovered delta 7

    await WriteBuffer.close()
  })

  it('should recover queue rows from LMDB on startup', async () => {
    await db.schema.createTable('activity_log', table => {
      table.increments('id')
      table.integer('user_id')
      table.string('action', 50)
    })

    const mockStorage = createMockStorage()
    storageData.set('wb:q:default:activity_log', [{user_id: 1, action: 'recovered_view'}])

    global.Odac = {
      Config: {buffer: {flushInterval: 999999, checkpointInterval: 999999}},
      Storage: mockStorage
    }

    const WriteBuffer = require('../../../src/Database/WriteBuffer')
    await WriteBuffer.init({default: db})

    // Flush recovered data
    await WriteBuffer.flush()

    const rows = await db('activity_log').select()
    expect(rows).toHaveLength(1)
    expect(rows[0].action).toBe('recovered_view')

    await WriteBuffer.close()
  })

  it('should merge recovered data with new increments', async () => {
    const mockStorage = createMockStorage()
    storageData.set('wb:c:default:posts:1:views', {delta: 5, base: 100})

    global.Odac = {
      Config: {buffer: {flushInterval: 999999, checkpointInterval: 999999}},
      Storage: mockStorage
    }

    const WriteBuffer = require('../../../src/Database/WriteBuffer')
    await WriteBuffer.init({default: db})

    // Add more increments on top of recovered data
    await WriteBuffer.increment('default', 'posts', 1, 'views', 3)

    const result = await WriteBuffer.get('default', 'posts', 1, 'views')
    expect(result).toBe(108) // base 100 + recovered 5 + new 3

    await WriteBuffer.close()
  })

  it('should clear LMDB checkpoint after successful flush', async () => {
    const mockStorage = createMockStorage()
    storageData.set('wb:c:default:posts:1:views', {delta: 5, base: 100})

    global.Odac = {
      Config: {buffer: {flushInterval: 999999, checkpointInterval: 999999}},
      Storage: mockStorage
    }

    const WriteBuffer = require('../../../src/Database/WriteBuffer')
    await WriteBuffer.init({default: db})
    await WriteBuffer.flush()

    // Checkpoint data should be cleared
    expect(storageData.has('wb:c:default:posts:1:views')).toBe(false)

    await WriteBuffer.close()
  })
})
