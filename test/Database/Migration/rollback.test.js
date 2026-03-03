'use strict'

const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const knex = require('knex')
const Migration = require('../../../src/Database/Migration')

let db, tmpDir

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'odac-migration-rollback-'))
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

describe('Migration.rollback()', () => {
  it('should rollback the last batch', async () => {
    await db.schema.createTable('entries', t => {
      t.increments('id')
      t.string('name')
    })

    writeMigrationFile(
      '20260225_001_add_entry.js',
      async db => {
        await db('entries').insert({name: 'first'})
      },
      async db => {
        await db('entries').where('name', 'first').del()
      }
    )

    await Migration.migrate()
    const result = await Migration.rollback()
    expect(result.default).toEqual(
      expect.arrayContaining([expect.objectContaining({type: 'rolled_back', name: '20260225_001_add_entry.js'})])
    )

    const rows = await db('entries').select()
    expect(rows).toHaveLength(0)
  })
})
