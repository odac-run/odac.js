'use strict'

const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const knex = require('knex')
const Migration = require('../../../src/Database/Migration')

let db, tmpDir

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'odac-migration-seed-'))
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

describe('Migration.migrate() - Seed Data', () => {
  it('should insert seed data on first migrate', async () => {
    writeSchema('roles', {
      columns: {id: {type: 'increments'}, name: {type: 'string', length: 50}, level: {type: 'integer', default: 0}},
      seed: [
        {name: 'admin', level: 100},
        {name: 'user', level: 1}
      ],
      seedKey: 'name'
    })

    const result = await Migration.migrate()
    expect(result.default.seeds).toHaveLength(2)

    const rows = await db('roles').select()
    expect(rows).toHaveLength(2)
  })

  it('should update seed data if values changed', async () => {
    writeSchema('settings', {
      columns: {id: {type: 'increments'}, key: {type: 'string', length: 100}, value: {type: 'string', length: 255}},
      seed: [{key: 'site_name', value: 'My App'}],
      seedKey: 'key'
    })

    await Migration.migrate()

    writeSchema('settings', {
      columns: {id: {type: 'increments'}, key: {type: 'string', length: 100}, value: {type: 'string', length: 255}},
      seed: [{key: 'site_name', value: 'New App Name'}],
      seedKey: 'key'
    })

    await Migration.migrate()
    const row = await db('settings').where('key', 'site_name').first()
    expect(row.value).toBe('New App Name')
  })

  it('should handle JSON/JSONB seeds without false positives', async () => {
    writeSchema('apps_json', {
      columns: {id: {type: 'increments'}, name: {type: 'string', length: 100}, config: {type: 'json'}},
      seed: [{name: 'myapp', config: JSON.stringify({host: 'data'})}],
      seedKey: 'name'
    })

    await Migration.migrate()
    const result2 = await Migration.migrate()
    expect(result2.default.seeds.filter(s => s.type === 'seed_update')).toHaveLength(0)
  })
})
