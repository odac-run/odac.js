'use strict'

const knexLib = require('knex')

// count() returns a plain number for an ungrouped count. A grouped count is one row per
// group and must stay an array even when a single group matches.

let db

beforeEach(async () => {
  db = knexLib({client: 'sqlite3', connection: {filename: ':memory:'}, useNullAsDefault: true})
  await db.schema.createTable('orders', table => {
    table.increments('id')
    table.string('status')
  })
  await db('orders').insert([{status: 'paid'}, {status: 'paid'}, {status: 'open'}])
})

afterEach(async () => {
  await db.destroy()
  jest.resetModules()
})

function load() {
  const DB = require('../../src/Database')
  DB.connections = {default: db}
  db._odacConnectionKey = 'default'
  DB._nanoidColumns = {}
  return DB
}

describe('Database count()', () => {
  it('returns a number for an ungrouped count', async () => {
    const DB = load()
    await expect(DB.orders.count()).resolves.toBe(3)
    await expect(DB.orders.where('status', 'paid').count()).resolves.toBe(2)
  })

  it('keeps a grouped count as rows when a single group matches', async () => {
    const DB = load()
    const rows = await DB.orders.where('status', 'paid').groupBy('status').count()
    expect(Array.isArray(rows)).toBe(true)
    expect(rows).toHaveLength(1)
  })

  it('keeps a grouped count as rows when the group is added after count()', async () => {
    const DB = load()
    const rows = await DB.orders.count('id as n').where('status', 'open').groupBy('status')
    expect(rows).toEqual([{n: 1}])
  })
})
