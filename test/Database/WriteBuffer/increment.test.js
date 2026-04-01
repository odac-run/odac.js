'use strict'

const cluster = require('node:cluster')

/**
 * Tests WriteBuffer.increment().
 * Why: Validates that the Write-Behind Cache correctly accumulates deltas
 * and returns accurate current totals (base + buffered delta) without a DB write.
 */

let knexLib, db, WriteBuffer

beforeEach(async () => {
  jest.resetModules()

  knexLib = require('knex')
  db = knexLib({client: 'sqlite3', connection: {filename: ':memory:'}, useNullAsDefault: true})

  // Create test table
  await db.schema.createTable('posts', table => {
    table.integer('id').primary()
    table.integer('views').defaultTo(0)
    table.integer('likes').defaultTo(0)
    table.string('title', 255)
  })

  // Seed data
  await db('posts').insert([
    {id: 1, views: 100, likes: 10, title: 'First Post'},
    {id: 2, views: 200, likes: 20, title: 'Second Post'}
  ])

  // Mock cluster as primary
  Object.defineProperty(cluster, 'isPrimary', {value: true, configurable: true})

  // Mock global.Odac
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

describe('WriteBuffer - increment()', () => {
  it('should increment and return base + delta on first call', async () => {
    const result = await WriteBuffer.increment('default', 'posts', 1, 'views')
    expect(result).toBe(101) // DB base 100 + delta 1
  })

  it('should accumulate multiple increments correctly', async () => {
    await WriteBuffer.increment('default', 'posts', 1, 'views')
    await WriteBuffer.increment('default', 'posts', 1, 'views')
    const result = await WriteBuffer.increment('default', 'posts', 1, 'views')
    expect(result).toBe(103) // 100 + 3
  })

  it('should support custom delta values', async () => {
    const result = await WriteBuffer.increment('default', 'posts', 1, 'views', 5)
    expect(result).toBe(105) // 100 + 5
  })

  it('should handle different columns independently', async () => {
    await WriteBuffer.increment('default', 'posts', 1, 'views', 3)
    await WriteBuffer.increment('default', 'posts', 1, 'likes', 2)

    const views = await WriteBuffer.get('default', 'posts', 1, 'views')
    const likes = await WriteBuffer.get('default', 'posts', 1, 'likes')

    expect(views).toBe(103) // 100 + 3
    expect(likes).toBe(12) // 10 + 2
  })

  it('should handle different rows independently', async () => {
    await WriteBuffer.increment('default', 'posts', 1, 'views', 5)
    await WriteBuffer.increment('default', 'posts', 2, 'views', 10)

    const row1 = await WriteBuffer.get('default', 'posts', 1, 'views')
    const row2 = await WriteBuffer.get('default', 'posts', 2, 'views')

    expect(row1).toBe(105) // 100 + 5
    expect(row2).toBe(210) // 200 + 10
  })

  it('should handle composite where keys', async () => {
    // Create a table with composite key
    await db.schema.createTable('post_stats', table => {
      table.integer('post_id')
      table.string('date', 10)
      table.integer('views').defaultTo(0)
      table.primary(['post_id', 'date'])
    })
    await db('post_stats').insert({post_id: 1, date: '2026-04-01', views: 50})

    const result = await WriteBuffer.increment('default', 'post_stats', {post_id: 1, date: '2026-04-01'}, 'views', 3)
    expect(result).toBe(53) // 50 + 3
  })

  it('should return 0 + delta for non-existent rows', async () => {
    const result = await WriteBuffer.increment('default', 'posts', 999, 'views')
    expect(result).toBe(1) // 0 base + 1
  })
})
