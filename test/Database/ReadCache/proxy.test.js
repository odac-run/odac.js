'use strict'

const cluster = require('node:cluster')

/**
 * Tests the cache chain API exposed via Database.js proxy.
 * Why: Validates that Odac.DB.posts.cache(60).where(...).select(...) pattern
 * correctly delegates to ReadCache, and that write operations auto-invalidate.
 */

let knexLib, db

beforeEach(async () => {
  jest.resetModules()

  knexLib = require('knex')
  db = knexLib({client: 'sqlite3', connection: {filename: ':memory:'}, useNullAsDefault: true})

  await db.schema.createTable('posts', table => {
    table.integer('id').primary()
    table.string('title', 255)
    table.integer('views').defaultTo(0)
    table.boolean('active').defaultTo(true)
  })

  await db('posts').insert([
    {id: 1, title: 'First Post', views: 100, active: true},
    {id: 2, title: 'Second Post', views: 200, active: true},
    {id: 3, title: 'Draft', views: 0, active: false}
  ])

  Object.defineProperty(cluster, 'isPrimary', {value: true, configurable: true})

  const Ipc = require('../../../src/Ipc')
  global.Odac = {
    Config: {
      cache: {ttl: 60, maxKeys: 10000},
      buffer: {flushInterval: 999999, checkpointInterval: 999999}
    },
    Storage: {
      isReady: () => false,
      put: jest.fn(),
      remove: jest.fn(),
      getRange: () => []
    },
    Ipc
  }
  await Ipc.init()

  const writeBuffer = require('../../../src/Database/WriteBuffer')
  await writeBuffer.init({default: db})

  const readCache = require('../../../src/Database/ReadCache')
  readCache.init()

  const DB = require('../../../src/Database')
  DB.connections = {default: db}
})

afterEach(async () => {
  const writeBuffer = require('../../../src/Database/WriteBuffer')
  await writeBuffer.close()
  await Odac.Ipc.close()
  await db.destroy()
  delete global.Odac
})

describe('Database.js Proxy - cache(ttl).where().select()', () => {
  it('should cache SELECT results with specified TTL', async () => {
    const DB = require('../../../src/Database')

    const result1 = await DB.posts.cache(60).where({active: true}).select('id', 'title')
    expect(result1).toHaveLength(2)

    // Modify DB directly
    await db('posts').where({id: 1}).update({title: 'Modified'})

    // Should return cached (stale) data
    const result2 = await DB.posts.cache(60).where({active: true}).select('id', 'title')
    expect(result2[0].title).toBe('First Post')
  })

  it('should cache with default TTL when called without argument', async () => {
    const DB = require('../../../src/Database')

    const result = await DB.posts.cache().where({id: 1}).first()
    expect(result.title).toBe('First Post')

    // Verify cached
    const keys = await Odac.Ipc.smembers('rc:idx:default:posts')
    expect(keys).toHaveLength(1)
  })
})

describe('Database.js Proxy - cache.clear()', () => {
  it('should manually clear table cache via Odac.DB.posts.cache.clear()', async () => {
    const DB = require('../../../src/Database')

    await DB.posts.cache(60).where({active: true}).select('id', 'title')

    let keys = await Odac.Ipc.smembers('rc:idx:default:posts')
    expect(keys).toHaveLength(1)

    await DB.posts.cache.clear()

    keys = await Odac.Ipc.smembers('rc:idx:default:posts')
    expect(keys).toHaveLength(0)
  })
})

describe('Database.js Proxy - automatic invalidation on write', () => {
  it('should invalidate cache after update()', async () => {
    const DB = require('../../../src/Database')

    // Cache a query
    await DB.posts.cache(60).where({active: true}).select('id', 'title')
    let keys = await Odac.Ipc.smembers('rc:idx:default:posts')
    expect(keys).toHaveLength(1)

    // Update via proxy — should auto-invalidate
    await DB.posts.where({id: 1}).update({title: 'Updated'})

    keys = await Odac.Ipc.smembers('rc:idx:default:posts')
    expect(keys).toHaveLength(0)

    // Next cache() call should fetch fresh data
    const result = await DB.posts.cache(60).where({id: 1}).first()
    expect(result.title).toBe('Updated')
  })

  it('should invalidate cache after insert()', async () => {
    const DB = require('../../../src/Database')

    await DB.posts.cache(60).where({active: true}).select('id', 'title')
    let keys = await Odac.Ipc.smembers('rc:idx:default:posts')
    expect(keys).toHaveLength(1)

    await DB.posts.insert({id: 4, title: 'New Post', views: 0, active: true})

    keys = await Odac.Ipc.smembers('rc:idx:default:posts')
    expect(keys).toHaveLength(0)
  })

  it('should invalidate cache after delete()', async () => {
    const DB = require('../../../src/Database')

    await DB.posts.cache(60).where({active: true}).select('id', 'title')
    let keys = await Odac.Ipc.smembers('rc:idx:default:posts')
    expect(keys).toHaveLength(1)

    await DB.posts.where({id: 3}).delete()

    keys = await Odac.Ipc.smembers('rc:idx:default:posts')
    expect(keys).toHaveLength(0)
  })

  it('should invalidate cache after del() (alias)', async () => {
    const DB = require('../../../src/Database')

    await DB.posts.cache(60).where({active: true}).select('id', 'title')
    let keys = await Odac.Ipc.smembers('rc:idx:default:posts')
    expect(keys).toHaveLength(1)

    await DB.posts.where({id: 3}).del()

    keys = await Odac.Ipc.smembers('rc:idx:default:posts')
    expect(keys).toHaveLength(0)
  })
})

describe('Database.js Proxy - cache() via DB.table()', () => {
  it('should expose cache() on DB.table(name) just like DB.name', async () => {
    const DB = require('../../../src/Database')

    const result = await DB.table('posts').cache(60).where({active: true}).select('id', 'title')

    expect(result).toHaveLength(2)

    const keys = await Odac.Ipc.smembers('rc:idx:default:posts')
    expect(keys).toHaveLength(1)
  })

  it('should expose buffer on DB.table(name) just like DB.name', async () => {
    const DB = require('../../../src/Database')

    expect(typeof DB.table('posts').buffer.insert).toBe('function')
  })

  it('should invalidate cache after a write issued through DB.table()', async () => {
    const DB = require('../../../src/Database')

    await DB.table('posts').cache(60).where({active: true}).select('id', 'title')
    expect(await Odac.Ipc.smembers('rc:idx:default:posts')).toHaveLength(1)

    await DB.table('posts').where({id: 1}).update({title: 'Updated'})

    expect(await Odac.Ipc.smembers('rc:idx:default:posts')).toHaveLength(0)
  })
})

describe('Database.js Proxy - clauses chained before cache()', () => {
  it('should preserve where() applied before cache()', async () => {
    const DB = require('../../../src/Database')

    // The WHERE must survive .cache() — a fresh builder would return all 3 rows.
    const result = await DB.posts.where({active: false}).cache(60).select('id', 'title')

    expect(result).toHaveLength(1)
    expect(result[0].title).toBe('Draft')
  })

  it('should not collide cache keys between queries that differ only before cache()', async () => {
    const DB = require('../../../src/Database')

    const active = await DB.posts.where({active: true}).cache(60).select('id')
    const drafts = await DB.posts.where({active: false}).cache(60).select('id')

    expect(active).toHaveLength(2)
    expect(drafts).toHaveLength(1)

    const keys = await Odac.Ipc.smembers('rc:idx:default:posts')
    expect(keys).toHaveLength(2)
  })
})

describe('Database.js Proxy - cache() with count()', () => {
  it('should return a scalar number for cached counts', async () => {
    const DB = require('../../../src/Database')

    const first = await DB.posts.cache(60).where({active: true}).count()
    expect(first).toBe(2)

    // Second call is served from cache — must still be a scalar, not [{...}]
    const second = await DB.posts.cache(60).where({active: true}).count()
    expect(second).toBe(2)
  })
})

describe('Database.js Proxy - global cache.clear()', () => {
  it('should clear cache via Odac.DB.cache.clear(connection, table)', async () => {
    const DB = require('../../../src/Database')

    await DB.posts.cache(60).where({active: true}).select('id', 'title')
    let keys = await Odac.Ipc.smembers('rc:idx:default:posts')
    expect(keys).toHaveLength(1)

    await DB.cache.clear('default', 'posts')

    keys = await Odac.Ipc.smembers('rc:idx:default:posts')
    expect(keys).toHaveLength(0)
  })
})
