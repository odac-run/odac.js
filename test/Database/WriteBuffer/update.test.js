'use strict'

const cluster = require('node:cluster')

/**
 * Tests WriteBuffer.update() — last-write-wins coalescing.
 * Why: Validates that repeated updates to the same row collapse into one UPDATE query,
 * and that different rows/tables are isolated correctly.
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
    table.string('slug', 255)
  })

  await db('posts').insert([
    {id: 1, views: 100, title: 'First Post', slug: 'first-post'},
    {id: 2, views: 200, title: 'Second Post', slug: 'second-post'}
  ])

  Object.defineProperty(cluster, 'isPrimary', {value: true, configurable: true})

  const Ipc = require('../../../src/Ipc')
  global.Odac = {
    Config: {buffer: {flushInterval: 999999, checkpointInterval: 999999}},
    Storage: {
      isReady: () => false,
      put: jest.fn(),
      remove: jest.fn(),
      getRange: () => []
    },
    Ipc
  }
  await Ipc.init()

  WriteBuffer = require('../../../src/Database/WriteBuffer')
  await WriteBuffer.init({default: db})
})

afterEach(async () => {
  await WriteBuffer.close()
  await Odac.Ipc.close()
  await db.destroy()
  delete global.Odac
})

describe('WriteBuffer - update()', () => {
  it('should buffer and flush a single update', async () => {
    await WriteBuffer.update('default', 'posts', 1, {title: 'Updated Title'})
    await WriteBuffer.flush()

    const row = await db('posts').where({id: 1}).first()
    expect(row.title).toBe('Updated Title')
    expect(row.slug).toBe('first-post') // Untouched
  })

  it('should merge multiple updates (last-write-wins)', async () => {
    await WriteBuffer.update('default', 'posts', 1, {title: 'First Update'})
    await WriteBuffer.update('default', 'posts', 1, {title: 'Second Update'})
    await WriteBuffer.flush()

    const row = await db('posts').where({id: 1}).first()
    expect(row.title).toBe('Second Update')
  })

  it('should merge different columns from multiple updates', async () => {
    await WriteBuffer.update('default', 'posts', 1, {title: 'New Title'})
    await WriteBuffer.update('default', 'posts', 1, {slug: 'new-slug'})
    await WriteBuffer.flush()

    const row = await db('posts').where({id: 1}).first()
    expect(row.title).toBe('New Title')
    expect(row.slug).toBe('new-slug')
  })

  it('should handle different rows independently', async () => {
    await WriteBuffer.update('default', 'posts', 1, {title: 'Row 1'})
    await WriteBuffer.update('default', 'posts', 2, {title: 'Row 2'})
    await WriteBuffer.flush()

    const row1 = await db('posts').where({id: 1}).first()
    const row2 = await db('posts').where({id: 2}).first()
    expect(row1.title).toBe('Row 1')
    expect(row2.title).toBe('Row 2')
  })

  it('should handle composite where key', async () => {
    await db.schema.createTable('user_prefs', table => {
      table.string('pref_key', 50)
      table.integer('user_id')
      table.string('value', 255)
      table.primary(['pref_key', 'user_id'])
    })
    await db('user_prefs').insert({pref_key: 'theme', user_id: 1, value: 'light'})

    await WriteBuffer.update('default', 'user_prefs', {pref_key: 'theme', user_id: 1}, {value: 'dark'})
    await WriteBuffer.flush()

    const row = await db('user_prefs').where({pref_key: 'theme', user_id: 1}).first()
    expect(row.value).toBe('dark')
  })

  it('should return true when buffered', async () => {
    const result = await WriteBuffer.update('default', 'posts', 1, {title: 'Test'})
    expect(result).toBe(true)
  })

  it('should clear update index after successful flush', async () => {
    await WriteBuffer.update('default', 'posts', 1, {title: 'Test'})
    await WriteBuffer.flush()

    const remaining = await Odac.Ipc.smembers('wb:idx:updates')
    expect(remaining).toHaveLength(0)
  })

  it('should combine increment and update on same row during flush', async () => {
    await WriteBuffer.increment('default', 'posts', 1, 'views', 5)
    await WriteBuffer.update('default', 'posts', 1, {title: 'Combo Test'})
    await WriteBuffer.flush()

    const row = await db('posts').where({id: 1}).first()
    expect(row.views).toBe(105)
    expect(row.title).toBe('Combo Test')
  })

  it('should handle different tables independently', async () => {
    await db.schema.createTable('comments', table => {
      table.integer('id').primary()
      table.string('body', 255)
    })
    await db('comments').insert({id: 1, body: 'Original'})

    await WriteBuffer.update('default', 'posts', 1, {title: 'Post Updated'})
    await WriteBuffer.update('default', 'comments', 1, {body: 'Comment Updated'})
    await WriteBuffer.flush()

    const post = await db('posts').where({id: 1}).first()
    const comment = await db('comments').where({id: 1}).first()
    expect(post.title).toBe('Post Updated')
    expect(comment.body).toBe('Comment Updated')
  })

  it('should scope flush to specific table when provided', async () => {
    await db.schema.createTable('comments', table => {
      table.integer('id').primary()
      table.string('body', 255)
    })
    await db('comments').insert({id: 1, body: 'Original'})

    await WriteBuffer.update('default', 'posts', 1, {title: 'Post Updated'})
    await WriteBuffer.update('default', 'comments', 1, {body: 'Comment Updated'})

    // Flush only posts
    await WriteBuffer.flush('default', 'posts')

    const post = await db('posts').where({id: 1}).first()
    const comment = await db('comments').where({id: 1}).first()
    expect(post.title).toBe('Post Updated')
    expect(comment.body).toBe('Original') // Not flushed
  })

  it('should not modify DB before flush is called', async () => {
    await WriteBuffer.update('default', 'posts', 1, {title: 'Buffered Only'})

    const row = await db('posts').where({id: 1}).first()
    expect(row.title).toBe('First Post') // Still original
  })
})
