'use strict'

const knexLib = require('knex')

/**
 * Tests the wrapWithInvalidation thenable returned by write operations (insert/update/delete/truncate).
 * Why: Ensures the thenable is fully Promise-compatible — supporting both await and .catch() chaining.
 * This prevents TypeError when consumers call .insert(...).catch() or .update(...).catch().
 */

let db

beforeEach(async () => {
  db = knexLib({client: 'sqlite3', connection: {filename: ':memory:'}, useNullAsDefault: true})
  await db.schema.createTable('tokens', table => {
    table.string('id', 21).primary()
    table.string('user', 100)
    table.string('token_x', 64)
  })
})

afterEach(async () => {
  await db.destroy()
  jest.resetModules()
})

describe('Database.js - wrapWithInvalidation thenable', () => {
  it('insert().catch() should be a function', () => {
    const DB = require('../../src/Database')
    DB.connections = {default: db}
    db._odacConnectionKey = 'default'
    DB._nanoidColumns = {}

    const result = DB.tokens.insert({id: 'test1', user: 'u1', token_x: 'tx1'})
    expect(typeof result.catch).toBe('function')
  })

  it('insert().catch() should resolve on success', async () => {
    const DB = require('../../src/Database')
    DB.connections = {default: db}
    db._odacConnectionKey = 'default'
    DB._nanoidColumns = {}

    const result = await DB.tokens.insert({id: 'test2', user: 'u2', token_x: 'tx2'}).catch(() => false)
    expect(result).not.toBe(false)

    const rows = await db('tokens').where('id', 'test2')
    expect(rows).toHaveLength(1)
    expect(rows[0].user).toBe('u2')
  })

  it('insert().catch() should catch errors gracefully', async () => {
    const DB = require('../../src/Database')
    DB.connections = {default: db}
    db._odacConnectionKey = 'default'
    DB._nanoidColumns = {}

    // Insert first row
    await DB.tokens.insert({id: 'dup1', user: 'u1', token_x: 'tx1'})

    // Duplicate primary key — should trigger catch
    const result = await DB.tokens.insert({id: 'dup1', user: 'u2', token_x: 'tx2'}).catch(() => 'caught')
    expect(result).toBe('caught')
  })

  it('update().catch() should be a function', () => {
    const DB = require('../../src/Database')
    DB.connections = {default: db}
    db._odacConnectionKey = 'default'
    DB._nanoidColumns = {}

    const result = DB.tokens.where('id', 'x').update({user: 'new'})
    expect(typeof result.catch).toBe('function')
  })

  it('delete().catch() should be a function', () => {
    const DB = require('../../src/Database')
    DB.connections = {default: db}
    db._odacConnectionKey = 'default'
    DB._nanoidColumns = {}

    const result = DB.tokens.where('id', 'x').delete()
    expect(typeof result.catch).toBe('function')
  })

  it('insert() should work with await (no .catch)', async () => {
    const DB = require('../../src/Database')
    DB.connections = {default: db}
    db._odacConnectionKey = 'default'
    DB._nanoidColumns = {}

    await DB.tokens.insert({id: 'await1', user: 'u_await', token_x: 'tx_await'})

    const rows = await db('tokens').where('id', 'await1')
    expect(rows).toHaveLength(1)
    expect(rows[0].user).toBe('u_await')
  })
  describe('Knex chaining after a write', () => {
    let DB

    beforeEach(async () => {
      DB = require('../../src/Database')
      DB.connections = {default: db}
      db._odacConnectionKey = 'default'
      DB._nanoidColumns = {}
      await db('tokens').insert([
        {id: 'a', user: 'u1', token_x: '1'},
        {id: 'b', user: 'u2', token_x: '2'}
      ])
    })

    afterEach(() => {
      delete global.Odac
    })

    it('supports .update().where()', async () => {
      await DB.tokens.update({user: 'changed'}).where('id', 'a')
      expect((await db('tokens').where('id', 'a').first()).user).toBe('changed')
      expect((await db('tokens').where('id', 'b').first()).user).toBe('u2')
    })

    it('supports .delete().where() and .del().where()', async () => {
      await DB.tokens.delete().where('id', 'a')
      await DB.tokens.del().where('id', 'b')
      expect(await db('tokens')).toHaveLength(0)
    })

    it('supports .returning() and .finally()', async () => {
      const finallyFn = jest.fn()
      const rows = await DB.tokens.where('id', 'a').update({user: 'r'}).returning('id').finally(finallyFn)
      expect(rows).toEqual([{id: 'a'}])
      expect(finallyFn).toHaveBeenCalled()
    })

    it('supports .transacting()', async () => {
      await db.transaction(async trx => {
        await DB.tokens.where('id', 'a').update({user: 'trx'}).transacting(trx)
      })
      expect((await db('tokens').where('id', 'a').first()).user).toBe('trx')
    })

    it('still renders SQL via toString()', () => {
      expect(DB.tokens.update({user: 'x'}).where('id', 'a').toString()).toMatch(/^update `tokens` set `user` = 'x' where `id` = 'a'$/)
    })

    it('invalidates the read cache after update, delete, increment and decrement', async () => {
      await db.schema.alterTable('tokens', t => t.integer('hits').defaultTo(0))
      const invalidate = jest.spyOn(require('../../src/Database/ReadCache'), 'invalidate').mockResolvedValue()

      await DB.tokens.update({user: 'x'}).where('id', 'a')
      await DB.tokens.where('id', 'a').increment('hits', 2)
      await DB.tokens.where('id', 'a').decrement('hits', 1)
      await DB.tokens.where('id', 'b').delete()

      expect(invalidate).toHaveBeenCalledTimes(4)
      expect(invalidate).toHaveBeenCalledWith('default', 'tokens')
      expect((await db('tokens').where('id', 'a').first()).hits).toBe(1)
      invalidate.mockRestore()
    })

    it('resolves a successful write even when invalidation fails', async () => {
      const error = jest.spyOn(console, 'error').mockImplementation(() => {})
      global.Odac = {
        Ipc: {
          smembers: async () => {
            throw new Error('IPC shutting down')
          },
          del: async () => {}
        }
      }

      await expect(DB.tokens.where('id', 'a').update({user: 'kept'})).resolves.toBe(1)
      await expect(DB.tokens.insert({id: 'c', user: 'u3', token_x: '3'})).resolves.toBeDefined()
      expect((await db('tokens').where('id', 'a').first()).user).toBe('kept')
      expect(error).toHaveBeenCalled()
      error.mockRestore()
    })

    it('still rejects when the write itself fails', async () => {
      await expect(DB.tokens.insert({id: 'a', user: 'dup', token_x: 'x'})).rejects.toThrow()
    })
  })
})
