'use strict'

const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const knex = require('knex')
const Migration = require('../../../src/Database/Migration')

let db, tmpDir

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'odac-migration-snapshot-'))
  db = knex({client: 'sqlite3', connection: {filename: ':memory:'}, useNullAsDefault: true})
  Migration.init(tmpDir, {default: db})
})

afterEach(async () => {
  await db.destroy()
  fs.rmSync(tmpDir, {recursive: true, force: true})
})

describe('Migration.snapshot()', () => {
  it('should reverse-engineer existing tables into schema files', async () => {
    await db.schema.createTable('customers', t => {
      t.increments('id')
      t.string('name', 100)
      t.boolean('vip').defaultTo(false)
    })

    const result = await Migration.snapshot()
    const files = result.default

    expect(files.length).toBeGreaterThanOrEqual(1)
    const customerFile = files.find(f => f.includes('customers'))
    expect(customerFile).toBeDefined()
    expect(fs.existsSync(customerFile)).toBe(true)
  })
})
