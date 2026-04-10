'use strict'

const cluster = require('node:cluster')

/**
 * Tests ReadCache.invalidate() — table-level cache purge.
 * Why: Validates that all cached queries for a table are removed on invalidation,
 * and that unrelated tables remain unaffected.
 */

let knexLib, db

beforeEach(async () => {
  jest.resetModules()

  knexLib = require('knex')
  db = knexLib({client: 'sqlite3', connection: {filename: ':memory:'}, useNullAsDefault: true})

  await db.schema.createTable('posts', table => {
    table.integer('id').primary()
    table.string('title', 255)
  })

  await db.schema.createTable('users', table => {
    table.integer('id').primary()
    table.string('name', 255)
  })

  await db('posts').insert([
    {id: 1, title: 'Post A'},
    {id: 2, title: 'Post B'}
  ])

  await db('users').insert([{id: 1, name: 'Alice'}])

  Object.defineProperty(cluster, 'isPrimary', {value: true, configurable: true})

  const Ipc = require('../../../src/Ipc')
  global.Odac = {
    Config: {cache: {ttl: 60, maxKeys: 10000}},
    Ipc
  }
  await Ipc.init()
})

afterEach(async () => {
  await Odac.Ipc.close()
  await db.destroy()
  delete global.Odac
})

describe('ReadCache.invalidate()', () => {
  let readCache

  beforeEach(() => {
    readCache = require('../../../src/Database/ReadCache')
    readCache.init()
  })

  it('should purge all cached queries for the specified table', async () => {
    // Cache two different queries on posts
    const qb1 = db('posts').where({id: 1}).first()
    const qb2 = db('posts').where({id: 2}).first()
    await readCache.get('default', 'posts', qb1, () => qb1.then(r => r), 60)
    await readCache.get('default', 'posts', qb2, () => qb2.then(r => r), 60)

    const cachedKeys = await Odac.Ipc.smembers('rc:idx:default:posts')
    expect(cachedKeys).toHaveLength(2)

    // Invalidate
    await readCache.invalidate('default', 'posts')

    const keys = await Odac.Ipc.smembers('rc:idx:default:posts')
    expect(keys).toHaveLength(0)

    // Verify cache entries are actually deleted
    for (const key of cachedKeys) {
      const val = await Odac.Ipc.get(key)
      expect(val).toBeNull()
    }
  })

  it('should not affect cache of other tables', async () => {
    const qbPosts = db('posts').where({id: 1}).first()
    const qbUsers = db('users').where({id: 1}).first()
    await readCache.get('default', 'posts', qbPosts, () => qbPosts.then(r => r), 60)
    await readCache.get('default', 'users', qbUsers, () => qbUsers.then(r => r), 60)

    // Invalidate only posts
    await readCache.invalidate('default', 'posts')

    const postKeys = await Odac.Ipc.smembers('rc:idx:default:posts')
    const userKeys = await Odac.Ipc.smembers('rc:idx:default:users')

    expect(postKeys).toHaveLength(0)
    expect(userKeys).toHaveLength(1)
  })

  it('should be a no-op when no cache exists for the table', async () => {
    // Should not throw
    await expect(readCache.invalidate('default', 'nonexistent')).resolves.toBeUndefined()
  })
})
