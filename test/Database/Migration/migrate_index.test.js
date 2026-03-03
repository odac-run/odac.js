'use strict'

const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const knex = require('knex')
const Migration = require('../../../src/Database/Migration')

let db, tmpDir

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'odac-migration-index-'))
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

describe('Migration.migrate() - Index Diff', () => {
  it('should add a new index to an existing table', async () => {
    writeSchema('articles', {
      columns: {id: {type: 'increments'}, slug: {type: 'string', length: 255}, status: {type: 'string', length: 50}},
      indexes: []
    })
    await Migration.migrate()

    writeSchema('articles', {
      columns: {id: {type: 'increments'}, slug: {type: 'string', length: 255}, status: {type: 'string', length: 50}},
      indexes: [{columns: ['slug'], unique: true}]
    })

    const result = await Migration.migrate()
    const indexOps = result.default.schema.filter(op => op.type === 'add_index')
    expect(indexOps).toHaveLength(1)
  })

  it('should drop an index removed from schema', async () => {
    writeSchema('tags', {
      columns: {id: {type: 'increments'}, name: {type: 'string', length: 100}},
      indexes: [{columns: ['name'], unique: false}]
    })
    await Migration.migrate()

    writeSchema('tags', {
      columns: {id: {type: 'increments'}, name: {type: 'string', length: 100}},
      indexes: []
    })

    const result = await Migration.migrate()
    const dropIndexOps = result.default.schema.filter(op => op.type === 'drop_index')
    expect(dropIndexOps.length).toBeGreaterThanOrEqual(1)
  })

  it('should normalize column-level unique into indexes and be idempotent', async () => {
    writeSchema('apps', {
      columns: {id: {type: 'increments'}, name: {type: 'string', length: 100, unique: true}},
      indexes: []
    })

    await Migration.migrate()
    const result2 = await Migration.migrate()
    const indexOps2 = result2.default.schema.filter(op => op.type === 'add_index' || op.type === 'drop_index')
    expect(indexOps2).toHaveLength(0)
  })

  it('should survive add_index when constraint already exists (idempotent)', async () => {
    await db.schema.createTable('apps_ext', t => {
      t.increments('id')
      t.string('name', 100).notNullable()
      t.unique(['name'])
    })

    writeSchema('apps_ext', {
      columns: {id: {type: 'increments'}, name: {type: 'string', length: 100, nullable: false, unique: true}},
      indexes: []
    })

    await expect(Migration.migrate()).resolves.toBeDefined()
  })
})
