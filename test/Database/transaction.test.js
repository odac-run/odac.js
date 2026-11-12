'use strict'

const knexLib = require('knex')

// Writes inside Odac.DB.transaction() must purge the read cache, and only once the
// transaction has committed: invalidating earlier lets a concurrent read cache the
// pre-commit rows again.

let db
let DB
let invalidate

const flush = () => new Promise(resolve => setImmediate(resolve))
const invalidatedTables = () => invalidate.mock.calls.map(([connection, table]) => `${connection}:${table}`)

beforeEach(async () => {
  jest.resetModules()
  db = knexLib({client: 'sqlite3', connection: {filename: ':memory:'}, useNullAsDefault: true})
  await db.schema.createTable('posts', t => {
    t.increments('id')
    t.string('title')
    t.integer('views').defaultTo(0)
  })
  await db.schema.createTable('comments', t => {
    t.increments('id')
    t.string('body')
  })

  invalidate = jest.spyOn(require('../../src/Database/ReadCache'), 'invalidate').mockResolvedValue()
  DB = require('../../src/Database')
  db._odacConnectionKey = 'default'
  DB.connections = {default: db}
  DB._nanoidColumns = {}
})

afterEach(async () => {
  jest.restoreAllMocks()
  await db.destroy()
})

describe('Odac.DB.transaction()', () => {
  it('invalidates tables written through trx() after the commit, not before', async () => {
    await DB.transaction(async trx => {
      await trx('posts').insert({title: 'a'})
      await trx('posts as p').where('p.id', 1).update({title: 'b'})
      await trx('posts').where('id', 1).increment('views')
      await flush()
      expect(invalidate).not.toHaveBeenCalled()
    })
    await flush()

    expect(invalidatedTables()).toEqual(['default:posts'])
  })

  it('does not invalidate on rollback', async () => {
    await expect(
      DB.transaction(async trx => {
        await trx('posts').insert({title: 'a'})
        throw new Error('abort')
      })
    ).rejects.toThrow('abort')
    await flush()

    expect(invalidate).not.toHaveBeenCalled()
    expect(await db('posts').count({n: '*'})).toEqual([{n: 0}])
  })

  it('ignores reads', async () => {
    await DB.transaction(async trx => {
      await trx('posts').select('*')
      await trx('comments').first()
    })
    await flush()

    expect(invalidate).not.toHaveBeenCalled()
  })

  it('tracks the promise form until commit()', async () => {
    const trx = await DB.transaction()
    await trx('comments').insert({body: 'x'})
    await trx('posts').where('id', 99).del()
    await flush()
    expect(invalidate).not.toHaveBeenCalled()

    await trx.commit()
    await flush()

    expect(invalidatedTables().sort()).toEqual(['default:comments', 'default:posts'])
  })

  it('collects writes from nested transactions into the outer commit', async () => {
    await DB.transaction(async trx => {
      await trx.transaction(async inner => {
        await inner('comments').insert({body: 'x'})
      })
      await flush()
      expect(invalidate).not.toHaveBeenCalled()
    })
    await flush()

    expect(invalidatedTables()).toEqual(['default:comments'])
  })

  it('drops nested writes when the outer transaction rolls back', async () => {
    await expect(
      DB.transaction(async trx => {
        await trx.transaction(async inner => {
          await inner('comments').insert({body: 'x'})
        })
        throw new Error('abort')
      })
    ).rejects.toThrow('abort')
    await flush()

    expect(invalidate).not.toHaveBeenCalled()
  })

  it('invalidates again after commit for ODAC builders used with transacting()', async () => {
    await DB.transaction(async trx => {
      await DB.posts.insert({title: 'a'}).transacting(trx)
      invalidate.mockClear()
    })
    await flush()

    expect(invalidatedTables()).toEqual(['default:posts'])
  })

  it('tracks transactionProvider()', async () => {
    const provider = DB.transactionProvider()
    const trx = await provider()
    await trx('posts').insert({title: 'a'})
    await trx.commit()
    await flush()

    expect(invalidatedTables()).toEqual(['default:posts'])
  })

  it('keeps the named connection key', async () => {
    db._odacConnectionKey = 'analytics'
    DB.connections = {default: db, analytics: db}

    await DB.analytics.transaction(trx => trx('posts').insert({title: 'a'}))
    await flush()

    expect(invalidatedTables()).toEqual(['analytics:posts'])
  })
})
