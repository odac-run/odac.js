'use strict'

const cluster = require('node:cluster')

/**
 * Tests WriteBuffer update operations: last-write-wins coalescing.
 * Why: Validates that repeated SET operations (e.g., active_date) merge into
 * a single UPDATE per row at flush time, reducing DB writes dramatically.
 */

let knexLib, db, WriteBuffer

beforeEach(async () => {
  jest.resetModules()

  knexLib = require('knex')
  db = knexLib({client: 'sqlite3', connection: {filename: ':memory:'}, useNullAsDefault: true})

  await db.schema.createTable('users', table => {
    table.integer('id').primary()
    table.string('name', 100)
    table.string('active_date', 30)
    table.string('last_ip', 45)
    table.integer('login_count').defaultTo(0)
  })

  await db('users').insert([
    {id: 1, name: 'Alice', active_date: '2026-03-01', last_ip: '10.0.0.1', login_count: 5},
    {id: 2, name: 'Bob', active_date: '2026-03-15', last_ip: '10.0.0.2', login_count: 12}
  ])

  Object.defineProperty(cluster, 'isPrimary', {value: true, configurable: true})

  global.Odac = {
    Config: {buffer: {flushInterval: 999999, checkpointInterval: 999999}},
    Storage: {
      isReady: () => false,
      put: jest.fn(),
      remove: jest.fn(),
      getRange: () => []
    }
  }

  WriteBuffer = require('../../../src/Database/WriteBuffer')
  await WriteBuffer.init({default: db})
})

afterEach(async () => {
  await WriteBuffer.close()
  await db.destroy()
  delete global.Odac
  delete global.__odac_wb_message_handler
})

describe('WriteBuffer - Update: buffer.update()', () => {
  it('should buffer and flush a single column update', async () => {
    await WriteBuffer.update('default', 'users', 1, {active_date: '2026-04-01'})
    await WriteBuffer.flush()

    const row = await db('users').where({id: 1}).first()
    expect(row.active_date).toBe('2026-04-01')
  })

  it('should merge multiple updates to the same row (last-write-wins)', async () => {
    await WriteBuffer.update('default', 'users', 1, {active_date: '2026-04-01'})
    await WriteBuffer.update('default', 'users', 1, {active_date: '2026-04-02'})

    await WriteBuffer.flush()

    const row = await db('users').where({id: 1}).first()
    expect(row.active_date).toBe('2026-04-02') // Last write wins
  })

  it('should merge different columns into a single UPDATE', async () => {
    await WriteBuffer.update('default', 'users', 1, {active_date: '2026-04-01'})
    await WriteBuffer.update('default', 'users', 1, {last_ip: '192.168.1.1'})

    await WriteBuffer.flush()

    const row = await db('users').where({id: 1}).first()
    expect(row.active_date).toBe('2026-04-01')
    expect(row.last_ip).toBe('192.168.1.1')
    // Other columns untouched
    expect(row.name).toBe('Alice')
    expect(row.login_count).toBe(5)
  })

  it('should handle updates to different rows independently', async () => {
    await WriteBuffer.update('default', 'users', 1, {active_date: '2026-04-01'})
    await WriteBuffer.update('default', 'users', 2, {active_date: '2026-04-02'})

    await WriteBuffer.flush()

    const row1 = await db('users').where({id: 1}).first()
    const row2 = await db('users').where({id: 2}).first()
    expect(row1.active_date).toBe('2026-04-01')
    expect(row2.active_date).toBe('2026-04-02')
  })

  it('should handle composite where keys', async () => {
    await db.schema.createTable('user_prefs', table => {
      table.integer('user_id')
      table.string('pref_key', 50)
      table.string('pref_value', 255)
      table.primary(['user_id', 'pref_key'])
    })
    await db('user_prefs').insert({user_id: 1, pref_key: 'theme', pref_value: 'light'})

    await WriteBuffer.update('default', 'user_prefs', {user_id: 1, pref_key: 'theme'}, {pref_value: 'dark'})
    await WriteBuffer.flush()

    const row = await db('user_prefs').where({user_id: 1, pref_key: 'theme'}).first()
    expect(row.pref_value).toBe('dark')
  })

  it('should clear update buffer after successful flush', async () => {
    await WriteBuffer.update('default', 'users', 1, {active_date: '2026-04-01'})
    await WriteBuffer.flush()

    expect(WriteBuffer._updates.size).toBe(0)
  })

  it('should not affect other rows or tables during flush', async () => {
    await WriteBuffer.update('default', 'users', 1, {last_ip: '172.16.0.1'})
    await WriteBuffer.flush()

    const row2 = await db('users').where({id: 2}).first()
    expect(row2.last_ip).toBe('10.0.0.2') // Untouched
  })

  it('should scope flush to specific table', async () => {
    await db.schema.createTable('sessions', table => {
      table.integer('id').primary()
      table.string('token', 100)
    })
    await db('sessions').insert({id: 1, token: 'old'})

    await WriteBuffer.update('default', 'users', 1, {active_date: '2026-04-01'})
    await WriteBuffer.update('default', 'sessions', 1, {token: 'new'})

    // Flush only users
    await WriteBuffer.flush('default', 'users')

    const user = await db('users').where({id: 1}).first()
    const session = await db('sessions').where({id: 1}).first()
    expect(user.active_date).toBe('2026-04-01') // Flushed
    expect(session.token).toBe('old') // Not flushed
  })
})

describe('WriteBuffer - Update: coalescing with counters', () => {
  it('should flush both updates and counters in the same cycle', async () => {
    await WriteBuffer.update('default', 'users', 1, {active_date: '2026-04-01'})
    await WriteBuffer.increment('default', 'users', 1, 'login_count', 3)

    await WriteBuffer.flush()

    const row = await db('users').where({id: 1}).first()
    expect(row.active_date).toBe('2026-04-01')
    expect(row.login_count).toBe(8) // 5 + 3
  })
})

describe('WriteBuffer - Update: checkpoint recovery', () => {
  it('should recover updates from LMDB checkpoint', async () => {
    await WriteBuffer.close()
    jest.resetModules()

    const storageData = new Map()
    storageData.set('wb:u:default:users:1', {active_date: '2026-04-01', last_ip: '10.0.0.99'})

    global.Odac = {
      Config: {buffer: {flushInterval: 999999, checkpointInterval: 999999}},
      Storage: {
        isReady: () => true,
        put: (k, v) => storageData.set(k, v),
        remove: k => storageData.delete(k),
        getRange: ({start, end}) => {
          const results = []
          for (const [key, value] of storageData) {
            if (key >= start && key < end) results.push({key, value})
          }
          return results
        }
      }
    }

    WriteBuffer = require('../../../src/Database/WriteBuffer')
    await WriteBuffer.init({default: db})
    await WriteBuffer.flush()

    const row = await db('users').where({id: 1}).first()
    expect(row.active_date).toBe('2026-04-01')
    expect(row.last_ip).toBe('10.0.0.99')
  })
})
