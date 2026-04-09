'use strict'

const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const knex = require('knex')
const Migration = require('../../../src/Database/Migration')

let db, tmpDir

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'odac-migration-column-'))
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

describe('Migration.migrate() - Column Diff', () => {
  it('should add a new column to an existing table', async () => {
    writeSchema('posts', {columns: {id: {type: 'increments'}, title: {type: 'string'}}})
    await Migration.migrate()

    writeSchema('posts', {columns: {id: {type: 'increments'}, title: {type: 'string'}, body: {type: 'text', nullable: true}}})
    const result = await Migration.migrate()
    const addOps = result.default.schema.filter(op => op.type === 'add_column')

    expect(addOps).toEqual(expect.arrayContaining([expect.objectContaining({type: 'add_column', column: 'body', table: 'posts'})]))
    const info = await db('posts').columnInfo()
    expect(info).toHaveProperty('body')
  })

  it('should drop a column removed from schema', async () => {
    writeSchema('items', {columns: {id: {type: 'increments'}, name: {type: 'string'}, obsolete: {type: 'string'}}})
    await Migration.migrate()

    writeSchema('items', {columns: {id: {type: 'increments'}, name: {type: 'string'}}})
    const result = await Migration.migrate()
    const dropOps = result.default.schema.filter(op => op.type === 'drop_column')

    expect(dropOps).toEqual(expect.arrayContaining([expect.objectContaining({type: 'drop_column', column: 'obsolete', table: 'items'})]))
  })

  it('should alter a column when its default value changes', async () => {
    writeSchema('settings', {columns: {id: {type: 'increments'}, status: {type: 'string', default: 'active'}}})
    await Migration.migrate()

    writeSchema('settings', {columns: {id: {type: 'increments'}, status: {type: 'string', default: 'inactive'}}})
    const result = await Migration.migrate()
    const alterOps = result.default.schema.filter(op => op.type === 'alter_column')

    expect(alterOps).toEqual(expect.arrayContaining([expect.objectContaining({type: 'alter_column', column: 'status', table: 'settings'})]))
  })

  it('should alter a column when its default value is removed', async () => {
    writeSchema('settings', {columns: {id: {type: 'increments'}, status: {type: 'string', default: 'active'}}})
    await Migration.migrate()

    writeSchema('settings', {columns: {id: {type: 'increments'}, status: {type: 'string'}}})
    const result = await Migration.migrate()
    const alterOps = result.default.schema.filter(op => op.type === 'alter_column')

    expect(alterOps).toEqual(expect.arrayContaining([expect.objectContaining({type: 'alter_column', column: 'status', table: 'settings'})]))
  })

  it('should not alter a column when its default value is unchanged', async () => {
    writeSchema('settings', {columns: {id: {type: 'increments'}, status: {type: 'string', default: 'active'}}})
    await Migration.migrate()

    writeSchema('settings', {columns: {id: {type: 'increments'}, status: {type: 'string', default: 'active'}}})
    const result = await Migration.migrate()
    const alterOps = result.default.schema.filter(op => op.type === 'alter_column')

    expect(alterOps).toHaveLength(0)
  })
})
