'use strict'

const cluster = require('node:cluster')

/**
 * Tests WriteBuffer flush operations: counter flush (batch UPDATE) and queue flush (batch INSERT).
 * Why: Validates that buffered data is correctly persisted to the database,
 * with proper transaction handling and error recovery.
 */

let knexLib, db, WriteBuffer

beforeEach(async () => {
  jest.resetModules()

  knexLib = require('knex')
  db = knexLib({client: 'sqlite3', connection: {filename: ':memory:'}, useNullAsDefault: true})

  await db.schema.createTable('posts', table => {
    table.integer('id').primary()
    table.integer('views').defaultTo(0)
    table.integer('likes').defaultTo(0)
    table.string('title', 255)
  })

  await db('posts').insert([
    {id: 1, views: 100, likes: 10, title: 'First Post'},
    {id: 2, views: 200, likes: 20, title: 'Second Post'}
  ])

  Object.defineProperty(cluster, 'isPrimary', {value: true, configurable: true})

  global.Odac = {
    Config: {buffer: {flushInterval: 999999, checkpointInterval: 999999}},
    Storage: {
      isReady: () => false,
      put: jest.fn(),
      remove: jest.fn(),
      getRange: () => []
    }
  }

  WriteBuffer = require('../../../src/Database/WriteBuffer')
  await WriteBuffer.init({default: db})
})

afterEach(async () => {
  await WriteBuffer.close()
  await db.destroy()
  delete global.Odac
  delete global.__odac_wb_message_handler
})

describe('WriteBuffer - Counter Flush', () => {
  it('should persist accumulated deltas to the database', async () => {
    await WriteBuffer.increment('default', 'posts', 1, 'views', 5)
    await WriteBuffer.increment('default', 'posts', 2, 'views', 10)

    await WriteBuffer.flush()

    const row1 = await db('posts').where({id: 1}).first()
    const row2 = await db('posts').where({id: 2}).first()
    expect(row1.views).toBe(105)
    expect(row2.views).toBe(210)
  })

  it('should flush multiple columns for the same row', async () => {
    await WriteBuffer.increment('default', 'posts', 1, 'views', 3)
    await WriteBuffer.increment('default', 'posts', 1, 'likes', 7)

    await WriteBuffer.flush()

    const row = await db('posts').where({id: 1}).first()
    expect(row.views).toBe(103)
    expect(row.likes).toBe(17)
  })

  it('should clear counters after successful flush', async () => {
    await WriteBuffer.increment('default', 'posts', 1, 'views', 5)
    await WriteBuffer.flush()

    // Internal counters should be clear
    expect(WriteBuffer._counters.size).toBe(0)
  })

  it('should update base after flush so subsequent reads are correct', async () => {
    await WriteBuffer.increment('default', 'posts', 1, 'views', 5)
    await WriteBuffer.flush()

    // New increment after flush
    const result = await WriteBuffer.increment('default', 'posts', 1, 'views', 2)
    expect(result).toBe(107) // base updated to 105, + 2

    await WriteBuffer.flush()
    const row = await db('posts').where({id: 1}).first()
    expect(row.views).toBe(107)
  })

  it('should accumulate new deltas during flush correctly', async () => {
    await WriteBuffer.increment('default', 'posts', 1, 'views', 10)
    await WriteBuffer.flush()

    await WriteBuffer.increment('default', 'posts', 1, 'views', 3)
    await WriteBuffer.increment('default', 'posts', 1, 'views', 2)
    await WriteBuffer.flush()

    const row = await db('posts').where({id: 1}).first()
    expect(row.views).toBe(115) // 100 + 10 + 5
  })

  it('should scope flush to specific table when provided', async () => {
    await db.schema.createTable('comments', table => {
      table.integer('id').primary()
      table.integer('votes').defaultTo(0)
    })
    await db('comments').insert({id: 1, votes: 50})

    await WriteBuffer.increment('default', 'posts', 1, 'views', 5)
    await WriteBuffer.increment('default', 'comments', 1, 'votes', 3)

    // Flush only posts
    await WriteBuffer.flush('default', 'posts')

    const post = await db('posts').where({id: 1}).first()
    const comment = await db('comments').where({id: 1}).first()
    expect(post.views).toBe(105) // Flushed
    expect(comment.votes).toBe(50) // Not flushed
  })
})

describe('WriteBuffer - Queue Flush (Batch Insert)', () => {
  it('should batch insert queued rows', async () => {
    await db.schema.createTable('activity_log', table => {
      table.increments('id')
      table.integer('user_id')
      table.string('action', 50)
    })

    await WriteBuffer.insert('default', 'activity_log', {user_id: 1, action: 'view'})
    await WriteBuffer.insert('default', 'activity_log', {user_id: 2, action: 'click'})
    await WriteBuffer.insert('default', 'activity_log', {user_id: 1, action: 'scroll'})

    await WriteBuffer.flush()

    const rows = await db('activity_log').select()
    expect(rows).toHaveLength(3)
    expect(rows[0].action).toBe('view')
    expect(rows[1].action).toBe('click')
    expect(rows[2].action).toBe('scroll')
  })

  it('should clear queue after successful flush', async () => {
    await db.schema.createTable('events', table => {
      table.increments('id')
      table.string('type', 50)
    })

    await WriteBuffer.insert('default', 'events', {type: 'pageview'})
    await WriteBuffer.flush()

    const queue = WriteBuffer._queues.get('default:events')
    expect(!queue || queue.length === 0).toBe(true)
  })

  it('should handle empty queues gracefully', async () => {
    await expect(WriteBuffer.flush()).resolves.not.toThrow()
  })

  it('should auto-flush when maxQueueSize is reached', async () => {
    await db.schema.createTable('logs', table => {
      table.increments('id')
      table.string('msg', 50)
    })

    // Set low threshold for testing
    WriteBuffer._config.maxQueueSize = 3

    await WriteBuffer.insert('default', 'logs', {msg: 'a'})
    await WriteBuffer.insert('default', 'logs', {msg: 'b'})
    await WriteBuffer.insert('default', 'logs', {msg: 'c'}) // Triggers auto-flush

    // Wait a tick for async auto-flush
    await new Promise(r => setTimeout(r, 50))

    const rows = await db('logs').select()
    expect(rows.length).toBeGreaterThanOrEqual(3)
  })
})
