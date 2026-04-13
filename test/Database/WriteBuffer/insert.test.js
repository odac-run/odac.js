'use strict'

const cluster = require('node:cluster')

/**
 * Tests WriteBuffer.insert() nanoid auto-generation.
 * Why: WriteBuffer bypasses the Database.js proxy QB nanoid injection.
 * Rows must be populated with nanoid values before being queued to IPC,
 * otherwise flush writes to DB with a null primary key and violates NOT NULL.
 */

let knexLib, db

beforeEach(async () => {
  jest.resetModules()

  knexLib = require('knex')
  db = knexLib({client: 'sqlite3', connection: {filename: ':memory:'}, useNullAsDefault: true})

  await db.schema.createTable('activity', table => {
    table.string('id', 21).primary().notNullable()
    table.string('user', 255).notNullable()
    table.string('action', 50).notNullable()
  })

  await db.schema.createTable('events', table => {
    table.string('eid', 12).primary().notNullable()
    table.string('name', 100)
  })

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

  const writeBuffer = require('../../../src/Database/WriteBuffer')
  await writeBuffer.init(
    {default: db},
    {
      default: {
        activity: [{column: 'id', size: 21}],
        events: [{column: 'eid', size: 12}]
      }
    }
  )

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

describe('WriteBuffer.insert() - NanoID auto-generation', () => {
  it('should auto-generate nanoid for a column when not provided', async () => {
    const DB = require('../../../src/Database')

    await DB.activity.buffer.insert({user: 'alice', action: 'login'})
    await DB.activity.buffer.flush()

    const rows = await db('activity').select()
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBeTruthy()
    expect(rows[0].id).toHaveLength(21)
  })

  it('should not overwrite an explicitly provided id', async () => {
    const DB = require('../../../src/Database')

    await DB.activity.buffer.insert({id: 'my-custom-id-00000', user: 'bob', action: 'logout'})
    await DB.activity.buffer.flush()

    const row = await db('activity').first()
    expect(row.id).toBe('my-custom-id-00000')
  })

  it('should respect custom nanoid length from schema metadata', async () => {
    const DB = require('../../../src/Database')

    await DB.events.buffer.insert({name: 'page_view'})
    await DB.events.buffer.flush()

    const row = await db('events').first()
    expect(row.eid).toBeTruthy()
    expect(row.eid).toHaveLength(12)
  })

  it('should generate unique ids for multiple buffered inserts', async () => {
    const DB = require('../../../src/Database')

    await DB.activity.buffer.insert({user: 'alice', action: 'login'})
    await DB.activity.buffer.insert({user: 'bob', action: 'view'})
    await DB.activity.buffer.insert({user: 'carol', action: 'logout'})
    await DB.activity.buffer.flush()

    const rows = await db('activity').select()
    expect(rows).toHaveLength(3)

    const ids = rows.map(r => r.id)
    expect(new Set(ids).size).toBe(3) // all unique
    ids.forEach(id => expect(id).toHaveLength(21))
  })
})
