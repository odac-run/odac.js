'use strict'

const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')

/**
 * Tests the Database.js proxy's auto-nanoid insert interception and schema metadata loading.
 * Why: Validates that columns with type 'nanoid' are auto-populated on insert
 * without requiring manual Odac.DB.nanoid() calls — core to ODAC's zero-config philosophy.
 */

let tmpDir, knexLib, db

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'odac-db-autonanoid-'))
  knexLib = require('knex')
  db = knexLib({client: 'sqlite3', connection: {filename: ':memory:'}, useNullAsDefault: true})
})

afterEach(async () => {
  await db.destroy()
  fs.rmSync(tmpDir, {recursive: true, force: true})
  jest.resetModules()
})

function writeSchema(name, content) {
  const dir = path.join(tmpDir, 'schema')
  fs.mkdirSync(dir, {recursive: true})
  fs.writeFileSync(path.join(dir, `${name}.js`), `module.exports = ${JSON.stringify(content, null, 2)}`)
}

describe('Database.js - Auto NanoID Insert', () => {
  it('should auto-generate nanoid on single-row insert', async () => {
    await db.schema.createTable('posts', table => {
      table.string('id', 21).primary()
      table.string('title', 255)
    })

    const DB = require('../../src/Database')
    DB.connections = {default: db}
    DB._nanoidColumns = {posts: [{column: 'id', size: 21}]}

    // Access through the proxy — Odac.DB.posts.insert()
    await DB.posts.insert({title: 'Hello World'})

    const rows = await db('posts').select()
    expect(rows).toHaveLength(1)
    expect(rows[0].title).toBe('Hello World')
    expect(typeof rows[0].id).toBe('string')
    expect(rows[0].id.length).toBe(21)
    expect(rows[0].id).toMatch(/^[a-zA-Z0-9]+$/)
  })

  it('should auto-generate unique nanoid for bulk inserts', async () => {
    await db.schema.createTable('items', table => {
      table.string('id', 21).primary()
      table.string('name', 100)
    })

    const DB = require('../../src/Database')
    DB.connections = {default: db}
    DB._nanoidColumns = {items: [{column: 'id', size: 21}]}

    await DB.items.insert([{name: 'Item A'}, {name: 'Item B'}, {name: 'Item C'}])

    const rows = await db('items').select()
    expect(rows).toHaveLength(3)

    const ids = rows.map(r => r.id)
    expect(new Set(ids).size).toBe(3) // all unique

    for (const id of ids) {
      expect(id.length).toBe(21)
      expect(id).toMatch(/^[a-zA-Z0-9]+$/)
    }
  })

  it('should NOT overwrite user-provided id', async () => {
    await db.schema.createTable('docs', table => {
      table.string('id', 21).primary()
      table.string('content', 500)
    })

    const DB = require('../../src/Database')
    DB.connections = {default: db}
    DB._nanoidColumns = {docs: [{column: 'id', size: 21}]}

    await DB.docs.insert({id: 'MY_CUSTOM_ID_1234567', content: 'Test'})

    const rows = await db('docs').select()
    expect(rows[0].id).toBe('MY_CUSTOM_ID_1234567')
  })

  it('should support custom nanoid length per column', async () => {
    await db.schema.createTable('tokens', table => {
      table.string('code', 8).primary()
      table.string('label', 100)
    })

    const DB = require('../../src/Database')
    DB.connections = {default: db}
    DB._nanoidColumns = {tokens: [{column: 'code', size: 8}]}

    await DB.tokens.insert({label: 'discount'})

    const rows = await db('tokens').select()
    expect(rows[0].code.length).toBe(8)
    expect(rows[0].code).toMatch(/^[a-zA-Z0-9]+$/)
  })

  it('should NOT interfere with tables without nanoid columns', async () => {
    await db.schema.createTable('logs', table => {
      table.increments('id')
      table.string('message', 500)
    })

    const DB = require('../../src/Database')
    DB.connections = {default: db}
    DB._nanoidColumns = {} // no nanoid metadata

    await DB.logs.insert({message: 'test log'})

    const rows = await db('logs').select()
    expect(rows).toHaveLength(1)
    expect(rows[0].message).toBe('test log')
    expect(rows[0].id).toBe(1) // auto-increment
  })
})

describe('Database._loadNanoidMeta()', () => {
  it('should detect nanoid columns from schema files', () => {
    writeSchema('users', {
      columns: {
        id: {type: 'nanoid', primary: true},
        name: {type: 'string', length: 255}
      }
    })

    const DB = require('../../src/Database')
    global.__dir = tmpDir
    DB._nanoidColumns = {}
    DB._loadNanoidMeta()

    expect(DB._nanoidColumns).toHaveProperty('users')
    expect(DB._nanoidColumns.users).toEqual([{column: 'id', size: 21}])
  })

  it('should detect multiple nanoid columns in a single table', () => {
    writeSchema('events', {
      columns: {
        id: {type: 'nanoid', primary: true},
        public_id: {type: 'nanoid', length: 12},
        name: {type: 'string'}
      }
    })

    const DB = require('../../src/Database')
    global.__dir = tmpDir
    DB._nanoidColumns = {}
    DB._loadNanoidMeta()

    expect(DB._nanoidColumns.events).toEqual([
      {column: 'id', size: 21},
      {column: 'public_id', size: 12}
    ])
  })

  it('should skip tables without nanoid columns', () => {
    writeSchema('logs', {
      columns: {
        id: {type: 'increments'},
        message: {type: 'text'}
      }
    })

    const DB = require('../../src/Database')
    global.__dir = tmpDir
    DB._nanoidColumns = {}
    DB._loadNanoidMeta()

    expect(DB._nanoidColumns).not.toHaveProperty('logs')
  })

  it('should handle missing schema directory gracefully', () => {
    const DB = require('../../src/Database')
    global.__dir = tmpDir
    DB._nanoidColumns = {}
    DB._loadNanoidMeta()

    expect(DB._nanoidColumns).toEqual({})
  })

  it('should detect nanoid in subdirectory schemas (named connections)', () => {
    const subDir = path.join(tmpDir, 'schema', 'analytics')
    fs.mkdirSync(subDir, {recursive: true})
    fs.writeFileSync(
      path.join(subDir, 'metrics.js'),
      `module.exports = ${JSON.stringify({columns: {id: {type: 'nanoid', length: 16}, value: {type: 'integer'}}})}`
    )

    const DB = require('../../src/Database')
    global.__dir = tmpDir
    DB._nanoidColumns = {}
    DB._loadNanoidMeta()

    expect(DB._nanoidColumns.metrics).toEqual([{column: 'id', size: 16}])
  })
})
