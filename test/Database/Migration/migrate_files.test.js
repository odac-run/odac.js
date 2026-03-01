'use strict'

const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const knex = require('knex')
const Migration = require('../../../src/Database/Migration')

let db, tmpDir

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'odac-migration-files-'))
  db = knex({client: 'sqlite3', connection: {filename: ':memory:'}, useNullAsDefault: true})
  Migration.init(tmpDir, {default: db})
})

afterEach(async () => {
  await db.destroy()
  fs.rmSync(tmpDir, {recursive: true, force: true})
})

function writeMigrationFile(name, upFn, downFn) {
  const dir = path.join(tmpDir, 'migration')
  fs.mkdirSync(dir, {recursive: true})

  const content = `
    module.exports = {
      up: ${upFn.toString()},
      down: ${downFn ? downFn.toString() : 'undefined'}
    }
  `
  fs.writeFileSync(path.join(dir, name), content)
}

describe('Migration.migrate() - Migration Files', () => {
  it('should run pending migration files in order', async () => {
    await db.schema.createTable('counters', t => {
      t.increments('id')
      t.string('name')
      t.integer('value').defaultTo(0)
    })

    writeMigrationFile('20260225_001_init.js', async db => {
      await db('counters').insert({name: 'visits', value: 0})
    })
    writeMigrationFile('20260225_002_add.js', async db => {
      await db('counters').insert({name: 'signups', value: 0})
    })

    const result = await Migration.migrate()
    expect(result.default.files).toHaveLength(2)

    const rows = await db('counters').select()
    expect(rows).toHaveLength(2)
  })

  it('should not re-run already applied migration files', async () => {
    await db.schema.createTable('data', t => {
      t.increments('id')
      t.string('value')
    })

    writeMigrationFile('20260225_001_insert.js', async db => {
      await db('data').insert({value: 'test'})
    })
    await Migration.migrate()
    const result2 = await Migration.migrate()
    expect(result2.default.files).toHaveLength(0)
  })
})
