'use strict'

const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const knex = require('knex')
const Migration = require('../../../src/Database/Migration')

let db, tmpDir

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'odac-migration-status-'))
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

describe('Migration.status()', () => {
  it('should show pending changes without applying them (dry run)', async () => {
    writeSchema('preview', {
      columns: {id: {type: 'increments'}, name: {type: 'string'}},
      indexes: []
    })

    const result = await Migration.status()
    expect(result.default.schema).toEqual(expect.arrayContaining([expect.objectContaining({type: 'create_table', table: 'preview'})]))

    const exists = await db.schema.hasTable('preview')
    expect(exists).toBe(false)
  })
})
