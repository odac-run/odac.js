'use strict'

const cluster = require('node:cluster')

/**
 * Tests the chainable buffer API exposed via Database.js proxy.
 * Why: Validates that the Odac.DB.table.buffer.where(id).update(data) pattern
 * correctly delegates to WriteBuffer's internal methods.
 */

let knexLib, db

beforeEach(async () => {
  jest.resetModules()

  knexLib = require('knex')
  db = knexLib({client: 'sqlite3', connection: {filename: ':memory:'}, useNullAsDefault: true})

  await db.schema.createTable('posts', table => {
    table.integer('id').primary()
    table.integer('views').defaultTo(0)
    table.string('title', 255)
  })

  await db.schema.createTable('activity_log', table => {
    table.increments('id')
    table.integer('user_id')
    table.string('action', 50)
  })

  await db('posts').insert([
    {id: 1, views: 100, title: 'First Post'},
    {id: 2, views: 200, title: 'Second Post'}
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

  // Initialize WriteBuffer with our test DB
  const writeBuffer = require('../../../src/Database/WriteBuffer')
  await writeBuffer.init({default: db})

  // Wire up Database.js proxy
  const DB = require('../../../src/Database')
  DB.connections = {default: db}
})

afterEach(async () => {
  const writeBuffer = require('../../../src/Database/WriteBuffer')
  await writeBuffer.close()
  await db.destroy()
  delete global.Odac
  delete global.__odac_wb_message_handler
})

describe('Database.js Proxy - buffer.where().update()', () => {
  it('should buffer and flush via Odac.DB.posts.buffer.where(id).update()', async () => {
    const DB = require('../../../src/Database')

    await DB.posts.buffer.where(1).update({title: 'Updated Title'})
    await DB.posts.buffer.flush()

    const row = await db('posts').where({id: 1}).first()
    expect(row.title).toBe('Updated Title')
  })

  it('should merge multiple updates via chainable API', async () => {
    const DB = require('../../../src/Database')

    await DB.posts.buffer.where(1).update({title: 'New Title'})
    await DB.posts.buffer.where(1).update({title: 'Final Title'})
    await DB.posts.buffer.flush()

    const row = await db('posts').where({id: 1}).first()
    expect(row.title).toBe('Final Title')
  })
})

describe('Database.js Proxy - buffer.where().increment()', () => {
  it('should increment via Odac.DB.posts.buffer.where(id).increment(col)', async () => {
    const DB = require('../../../src/Database')

    const result = await DB.posts.buffer.where(1).increment('views')
    expect(result).toBe(101)
  })

  it('should support custom delta', async () => {
    const DB = require('../../../src/Database')

    const result = await DB.posts.buffer.where(1).increment('views', 5)
    expect(result).toBe(105)
  })
})

describe('Database.js Proxy - buffer.where().get()', () => {
  it('should get buffered value via Odac.DB.posts.buffer.where(id).get(col)', async () => {
    const DB = require('../../../src/Database')

    await DB.posts.buffer.where(1).increment('views', 10)
    const result = await DB.posts.buffer.where(1).get('views')
    expect(result).toBe(110)
  })
})

describe('Database.js Proxy - buffer.insert()', () => {
  it('should buffer insert via Odac.DB.activity_log.buffer.insert(row)', async () => {
    const DB = require('../../../src/Database')

    await DB.activity_log.buffer.insert({user_id: 1, action: 'view'})
    await DB.activity_log.buffer.insert({user_id: 2, action: 'click'})
    await DB.activity_log.buffer.flush()

    const rows = await db('activity_log').select()
    expect(rows).toHaveLength(2)
  })
})

describe('Database.js Proxy - buffer.flush()', () => {
  it('should flush all buffered data for the table', async () => {
    const DB = require('../../../src/Database')

    await DB.posts.buffer.where(1).increment('views', 5)
    await DB.posts.buffer.where(2).update({title: 'Changed'})
    await DB.posts.buffer.flush()

    const row1 = await db('posts').where({id: 1}).first()
    const row2 = await db('posts').where({id: 2}).first()
    expect(row1.views).toBe(105)
    expect(row2.title).toBe('Changed')
  })
})
