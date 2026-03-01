'use strict'

const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const knex = require('knex')
const Migration = require('../../../src/Database/Migration')

let db, tmpDir

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'odac-migration-table-'))
  db = knex({client: 'sqlite3', connection: {filename: ':memory:'}, useNullAsDefault: true})
  Migration.init(tmpDir, {default: db})
})

afterEach(async () => {
  await db.destroy()
  fs.rmSync(tmpDir, {recursive: true, force: true})
})

function writeSchema(name, content) {
  const dir = path.join(tmpDir, 'schema')
  fs.mkdirSync(dir, {recursive: true})
  fs.writeFileSync(path.join(dir, `${name}.js`), `module.exports = ${JSON.stringify(content, null, 2)}`)
}

describe('Migration.migrate() - Table Creation', () => {
  it('should create a new table from a schema file', async () => {
    writeSchema('products', {
      columns: {
        id: {type: 'increments'},
        name: {type: 'string', length: 100, nullable: false},
        price: {type: 'decimal', precision: 10, scale: 2},
        is_active: {type: 'boolean', default: true}
      }
    })

    await Migration.migrate()
    const exists = await db.schema.hasTable('products')
    expect(exists).toBe(true)

    const info = await db('products').columnInfo()
    expect(info).toHaveProperty('id')
    expect(info).toHaveProperty('name')
  })

  it('should create a table with timestamps virtual type', async () => {
    writeSchema('logs', {
      columns: {
        id: {type: 'increments'},
        message: {type: 'text'},
        timestamps: {type: 'timestamps'}
      }
    })

    await Migration.migrate()
    const info = await db('logs').columnInfo()
    expect(info).toHaveProperty('created_at')
    expect(info).toHaveProperty('updated_at')
  })

  it('should create a table with indexes', async () => {
    writeSchema('users', {
      columns: {
        id: {type: 'increments'},
        email: {type: 'string', length: 255, nullable: false},
        role: {type: 'string', length: 50}
      },
      indexes: [{columns: ['email'], unique: true}, {columns: ['role']}]
    })

    await Migration.migrate()
    const exists = await db.schema.hasTable('users')
    expect(exists).toBe(true)
  })

  it('should skip creation if table already exists', async () => {
    writeSchema('existing', {
      columns: {id: {type: 'increments'}, name: {type: 'string'}}
    })

    await Migration.migrate()
    const result2 = await Migration.migrate()
    const createOps = result2.default.schema.filter(op => op.type === 'create_table')
    expect(createOps).toHaveLength(0)
  })
})
