'use strict'

const cluster = require('node:cluster')

/**
 * Tests WriteBuffer.get().
 * Why: Validates that get() returns the accurate current value (DB base + buffered delta)
 * without flushing to the database.
 */

let knexLib, db, WriteBuffer

beforeEach(async () => {
  jest.resetModules()

  knexLib = require('knex')
  db = knexLib({client: 'sqlite3', connection: {filename: ':memory:'}, useNullAsDefault: true})

  await db.schema.createTable('posts', table => {
    table.integer('id').primary()
    table.integer('views').defaultTo(0)
    table.string('title', 255)
  })

  await db('posts').insert([
    {id: 1, views: 100, title: 'First Post'},
    {id: 2, views: 200, title: 'Second Post'}
  ])

  Object.defineProperty(cluster, 'isPrimary', {value: true, configurable: true})

  global.Odac = {
    Config: {},
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

describe('WriteBuffer - get()', () => {
  it('should return base value from DB when no buffer exists', async () => {
    const result = await WriteBuffer.get('default', 'posts', 1, 'views')
    expect(result).toBe(100)
  })

  it('should return base + delta when buffer exists', async () => {
    await WriteBuffer.increment('default', 'posts', 1, 'views', 7)
    const result = await WriteBuffer.get('default', 'posts', 1, 'views')
    expect(result).toBe(107)
  })

  it('should return 0 for non-existent rows', async () => {
    const result = await WriteBuffer.get('default', 'posts', 999, 'views')
    expect(result).toBe(0)
  })
})
