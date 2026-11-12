'use strict'

const servedFromCache = require('./servedFromCache')

const cluster = require('node:cluster')

/**
 * Tests cross-table cache invalidation for JOIN queries.
 * Why: A cached query like posts.join('users').cache().select() must be invalidated
 * when EITHER posts OR users is written to. Validates that cache keys are registered
 * in all joined tables' indexes.
 */

let knexLib, db

beforeEach(async () => {
  jest.resetModules()

  knexLib = require('knex')
  db = knexLib({client: 'sqlite3', connection: {filename: ':memory:'}, useNullAsDefault: true})

  await db.schema.createTable('posts', table => {
    table.integer('id').primary()
    table.string('title', 255)
    table.integer('user_id')
  })

  await db.schema.createTable('users', table => {
    table.integer('id').primary()
    table.string('name', 255)
  })

  await db.schema.createTable('categories', table => {
    table.integer('id').primary()
    table.string('label', 255)
  })

  await db('users').insert([
    {id: 1, name: 'Alice'},
    {id: 2, name: 'Bob'}
  ])

  await db('categories').insert([{id: 1, label: 'Tech'}])

  await db('posts').insert([
    {id: 1, title: 'Post A', user_id: 1},
    {id: 2, title: 'Post B', user_id: 2}
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

describe('Cross-table cache invalidation (JOIN queries)', () => {
  it('should supersede a joined query when either table is invalidated', async () => {
    const readCache = require('../../../src/Database/ReadCache')
    const build = () => db('posts').join('users', 'posts.user_id', '=', 'users.id').select('posts.title', 'users.name')

    expect(await servedFromCache('posts', build)).toBe(false)
    expect(await servedFromCache('posts', build)).toBe(true)

    await readCache.invalidate('default', 'users')
    expect(await servedFromCache('posts', build)).toBe(false)
    expect(await servedFromCache('posts', build)).toBe(true)

    await readCache.invalidate('default', 'posts')
    expect(await servedFromCache('posts', build)).toBe(false)
  })

  it('should invalidate joined query when joined table is written to', async () => {
    const DB = require('../../../src/Database')

    // Cache a JOIN query via proxy
    const result1 = await DB.posts.cache(60).join('users', 'posts.user_id', '=', 'users.id').select('posts.title', 'users.name')

    expect(result1).toHaveLength(2)

    // Write to the JOINED table (users) — should invalidate the cached join query
    await DB.users.where({id: 1}).update({name: 'Alice Updated'})

    // Next read should hit DB
    const result2 = await DB.posts.cache(60).join('users', 'posts.user_id', '=', 'users.id').select('posts.title', 'users.name')

    expect(result2[0].name).toBe('Alice Updated')
  })

  it('should invalidate joined query when primary table is written to', async () => {
    const DB = require('../../../src/Database')

    await DB.posts.cache(60).join('users', 'posts.user_id', '=', 'users.id').select('posts.title', 'users.name')

    // Write to the PRIMARY table (posts)
    await DB.posts.where({id: 1}).update({title: 'Updated Post'})

    // Fresh read should reflect the update
    const result = await DB.posts.cache(60).join('users', 'posts.user_id', '=', 'users.id').select('posts.title', 'users.name')

    expect(result[0].title).toBe('Updated Post')
  })

  it('should handle multiple joins', async () => {
    const readCache = require('../../../src/Database/ReadCache')

    const qb = db('posts')
      .join('users', 'posts.user_id', '=', 'users.id')
      .leftJoin('categories', 'posts.id', '=', 'categories.id')
      .select('posts.title', 'users.name', 'categories.label')

    const executeFn = () => qb.then(r => r)
    await readCache.get('default', 'posts', qb, executeFn, 60)
    const build = () =>
      db('posts')
        .join('users', 'posts.user_id', '=', 'users.id')
        .leftJoin('categories', 'posts.id', '=', 'categories.id')
        .select('posts.title', 'users.name', 'categories.label')

    // A write to ANY of the three tables supersedes the query
    for (const table of ['categories', 'users', 'posts']) {
      expect(await servedFromCache('posts', build)).toBe(true)
      await readCache.invalidate('default', table)
      expect(await servedFromCache('posts', build)).toBe(false)
    }
  })

  it('should handle aliased table names in joins', async () => {
    const readCache = require('../../../src/Database/ReadCache')

    const qb = db('posts').join('users as u', 'posts.user_id', '=', 'u.id').select('posts.title', 'u.name')

    const executeFn = () => qb.then(r => r)
    await readCache.get('default', 'posts', qb, executeFn, 60)

    // Tracked under 'users', not 'users as u'
    const build = () => db('posts').join('users as u', 'posts.user_id', '=', 'u.id').select('posts.title', 'u.name')
    expect(await servedFromCache('posts', build)).toBe(true)
    await readCache.invalidate('default', 'users')
    expect(await servedFromCache('posts', build)).toBe(false)
  })
})
