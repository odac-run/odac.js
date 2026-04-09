'use strict'

const cluster = require('node:cluster')

/**
 * Tests ReadCache.get() — the core read-through logic.
 * Why: Validates cache HIT/MISS behavior, TTL propagation, and maxKeys guard.
 */

let knexLib, db

beforeEach(async () => {
  jest.resetModules()

  knexLib = require('knex')
  db = knexLib({client: 'sqlite3', connection: {filename: ':memory:'}, useNullAsDefault: true})

  await db.schema.createTable('posts', table => {
    table.integer('id').primary()
    table.string('title', 255)
    table.boolean('active').defaultTo(true)
  })

  await db('posts').insert([
    {id: 1, title: 'First Post', active: true},
    {id: 2, title: 'Second Post', active: true},
    {id: 3, title: 'Draft', active: false}
  ])

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

describe('ReadCache.get()', () => {
  let readCache

  beforeEach(() => {
    readCache = require('../../../src/Database/ReadCache')
    readCache.init()
  })

  it('should return DB result on cache MISS and cache it', async () => {
    const qb = db('posts').where({active: true}).select('id', 'title')
    const executeFn = () => qb.then(r => r)
    const result = await readCache.get('default', 'posts', qb, executeFn, 60)

    expect(result).toHaveLength(2)
    expect(result[0].title).toBe('First Post')

    // Verify it was cached — check index
    const keys = await Odac.Ipc.smembers('rc:idx:default:posts')
    expect(keys).toHaveLength(1)
  })

  it('should return cached result on cache HIT without querying DB', async () => {
    const qb1 = db('posts').where({active: true}).select('id', 'title')
    const executeFn1 = () => qb1.then(r => r)
    const result1 = await readCache.get('default', 'posts', qb1, executeFn1, 60)

    // Modify DB directly — cache should NOT reflect this
    await db('posts').where({id: 1}).update({title: 'Modified'})

    const qb2 = db('posts').where({active: true}).select('id', 'title')
    const executeFn2 = () => qb2.then(r => r)
    const result2 = await readCache.get('default', 'posts', qb2, executeFn2, 60)

    // Should still return the old cached value
    expect(result2[0].title).toBe('First Post')
    expect(result1).toEqual(result2)
  })

  it('should use config default TTL when ttl parameter is 0', async () => {
    const qb = db('posts').where({id: 1}).first()
    const executeFn = () => qb.then(r => r)
    const result = await readCache.get('default', 'posts', qb, executeFn, 0)

    expect(result.title).toBe('First Post')

    // Should still be cached
    const keys = await Odac.Ipc.smembers('rc:idx:default:posts')
    expect(keys).toHaveLength(1)
  })

  it('should respect maxKeys limit', async () => {
    // Re-init with maxKeys = 1
    global.Odac.Config.cache = {ttl: 60, maxKeys: 1}

    readCache = require('../../../src/Database/ReadCache')
    readCache.init()

    const qb1 = db('posts').where({id: 1}).first()
    const executeFn1 = () => qb1.then(r => r)
    await readCache.get('default', 'posts', qb1, executeFn1, 60)

    const qb2 = db('posts').where({id: 2}).first()
    const executeFn2 = () => qb2.then(r => r)
    await readCache.get('default', 'posts', qb2, executeFn2, 60)

    // Only 1 key should be in the index (first one cached, second skipped)
    const keys = await Odac.Ipc.smembers('rc:idx:default:posts')
    expect(keys).toHaveLength(1)
  })

  it('should generate different keys for different queries', async () => {
    const qb1 = db('posts').where({id: 1}).first()
    const qb2 = db('posts').where({id: 2}).first()
    const executeFn1 = () => qb1.then(r => r)
    const executeFn2 = () => qb2.then(r => r)

    await readCache.get('default', 'posts', qb1, executeFn1, 60)
    await readCache.get('default', 'posts', qb2, executeFn2, 60)

    const keys = await Odac.Ipc.smembers('rc:idx:default:posts')
    expect(keys).toHaveLength(2)
  })
})
