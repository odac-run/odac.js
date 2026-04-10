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
})
