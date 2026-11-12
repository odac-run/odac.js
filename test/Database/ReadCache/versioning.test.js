'use strict'

const cluster = require('node:cluster')

/**
 * Versioned invalidation: a table counter in every cache key replaces the per-table key index.
 * Why: expired keys never left the index, so a never-written table stopped caching for good
 * at maxKeys; every miss fetched the whole index; a read racing a write could re-cache stale
 * rows; concurrent misses all hit the database; and HITs returned JSON-mangled types.
 */

let db
let readCache

beforeEach(async () => {
  jest.resetModules()
  db = require('knex')({client: 'sqlite3', connection: {filename: ':memory:'}, useNullAsDefault: true})
  await db.schema.createTable('posts', table => {
    table.integer('id').primary()
    table.string('title')
  })
  await db('posts').insert([
    {id: 1, title: 'First'},
    {id: 2, title: 'Second'},
    {id: 3, title: 'Third'}
  ])

  Object.defineProperty(cluster, 'isPrimary', {value: true, configurable: true})
  const Ipc = require('../../../src/Ipc')
  global.Odac = {Config: {cache: {ttl: 60, maxKeys: 2}}, Ipc}
  await Ipc.init()
  readCache = require('../../../src/Database/ReadCache')
  readCache.init()
})

afterEach(async () => {
  jest.restoreAllMocks()
  await Odac.Ipc.close()
  await db.destroy()
  delete global.Odac
})

const read = (id, executeFn) => {
  const qb = db('posts').where({id}).first()
  return readCache.get('default', 'posts', qb, executeFn ?? (() => qb.then(row => row)), 60)
}

const runs = async id => {
  let ran = 0
  const qb = db('posts').where({id}).first()
  await readCache.get(
    'default',
    'posts',
    qb,
    () => {
      ran++
      return qb.then(row => row)
    },
    60
  )
  return ran
}

describe('ReadCache versioning', () => {
  it('resumes caching on a never-written table once the cap window expires', async () => {
    await read(1)
    await read(2)
    expect(await runs(3)).toBe(1) // over maxKeys: not stored
    expect(await runs(3)).toBe(1)

    const now = Date.now()
    jest.spyOn(Date, 'now').mockReturnValue(now + 61000)
    expect(await runs(3)).toBe(1) // window expired: stored again
    expect(await runs(3)).toBe(0)
  })

  it('never fetches a key index on reads or writes', async () => {
    const smembers = jest.spyOn(Odac.Ipc, 'smembers')
    await read(1)
    await read(1)
    await readCache.invalidate('default', 'posts')
    expect(smembers).not.toHaveBeenCalled()
  })

  it('does not serve a result that raced with a write', async () => {
    let release
    const gate = new Promise(resolve => (release = resolve))
    // The read fetches the old row, then a write and its invalidation land before it caches.
    const racing = read(1, async () => {
      const row = await db('posts').where({id: 1}).first()
      await gate
      return row
    })
    await new Promise(resolve => setImmediate(resolve))
    await db('posts').where({id: 1}).update({title: 'Updated'})
    await readCache.invalidate('default', 'posts')
    release()
    expect((await racing).title).toBe('First')

    expect((await read(1)).title).toBe('Updated')
  })

  it('runs one query for concurrent identical misses in a process', async () => {
    let ran = 0
    const qb = () => db('posts').where({id: 1}).first()
    const slow = () => {
      ran++
      return new Promise(resolve => setTimeout(() => resolve(qb().then(row => row)), 20))
    }
    const results = await Promise.all([1, 2, 3].map(() => readCache.get('default', 'posts', qb(), slow, 60)))
    expect(ran).toBe(1)
    expect(results.map(row => row.title)).toEqual(['First', 'First', 'First'])
  })

  it('returns Dates and Buffers with the same types on a HIT as on the MISS', async () => {
    // Workers and Redis move values as JSON; the primary's direct calls would hide that.
    const store = new Map()
    jest.spyOn(Odac.Ipc, 'set').mockImplementation(async (key, value) => store.set(key, JSON.stringify(value)))
    jest.spyOn(Odac.Ipc, 'get').mockImplementation(async key => (store.has(key) ? JSON.parse(store.get(key)) : null))
    const value = {at: new Date('2026-11-12T10:00:00.000Z'), blob: Buffer.from([1, 2, 3]), nested: [{at: new Date(0)}], n: 1}
    const qb = db('posts').where({id: 1})
    const miss = await readCache.get('default', 'posts', qb, async () => value, 60)
    const hit = await readCache.get('default', 'posts', db('posts').where({id: 1}), async () => null, 60)

    expect(miss).toBe(value)
    expect(hit).toEqual(value)
    expect(hit.at).toBeInstanceOf(Date)
    expect(Buffer.isBuffer(hit.blob)).toBe(true)
    expect(hit.nested[0].at).toBeInstanceOf(Date)
  })

  it('caches null results', async () => {
    expect(await runs(99)).toBe(1)
    expect(await runs(99)).toBe(0)
  })
})
