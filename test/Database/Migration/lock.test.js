'use strict'

const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const knex = require('knex')
const Migration = require('../../../src/Database/Migration')

// Several instances starting at once must not run the same migrations concurrently, and a
// migration file must not be applied without its tracking row.

const MigrationClass = Migration.constructor
let tmpDir, dbs

const openDb = () => {
  const db = knex({client: 'sqlite3', connection: {filename: path.join(tmpDir, 'app.sqlite')}, useNullAsDefault: true})
  dbs.push(db)
  return db
}

const instance = db => {
  const migration = new MigrationClass()
  migration.init(tmpDir, {default: db})
  return migration
}

function writeMigrationFile(name, source) {
  const dir = path.join(tmpDir, 'migration')
  fs.mkdirSync(dir, {recursive: true})
  fs.writeFileSync(path.join(dir, name), source)
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'odac-migration-lock-'))
  dbs = []
})

afterEach(async () => {
  await Promise.all(dbs.map(db => db.destroy()))
  fs.rmSync(tmpDir, {recursive: true, force: true})
})

describe('Migration lock', () => {
  it('runs a migration file once when two instances migrate at the same time', async () => {
    const setup = openDb()
    await setup.schema.createTable('runs', t => t.increments('id'))
    writeMigrationFile(
      '001_slow.js',
      `module.exports = {up: async db => { await new Promise(r => setTimeout(r, 200)); await db('runs').insert({}) }}`
    )

    await Promise.all([instance(openDb()).migrate(), instance(openDb()).migrate()])

    expect(await setup('runs')).toHaveLength(1)
    expect(await setup('_odac_migrations').where('type', 'file')).toHaveLength(1)
  })

  it('releases the lock afterwards', async () => {
    const db = openDb()
    await instance(db).migrate()
    expect(await db('_odac_migrations_lock')).toHaveLength(0)
  })

  it('takes over a lock whose holder stopped renewing it', async () => {
    const db = openDb()
    const migration = instance(db)
    await migration._ensureLockTable(db)
    await db('_odac_migrations_lock').insert({id: 1, owner: 'crashed', expires_at: Date.now() - 1000})

    await expect(migration.migrate()).resolves.toBeDefined()
  })

  it('waits for a live lock to be released', async () => {
    const db = openDb()
    const migration = instance(db)
    await migration._ensureLockTable(db)
    await db('_odac_migrations_lock').insert({id: 1, owner: 'other', expires_at: Date.now() + 60000})

    let done = false
    const run = migration.migrate().then(() => (done = true))
    await new Promise(r => setTimeout(r, 300))
    expect(done).toBe(false)

    await db('_odac_migrations_lock').where('owner', 'other').del()
    await run
    expect(done).toBe(true)
  })
})

describe('Migration files and tracking', () => {
  it('rolls back a failing migration together with its tracking row', async () => {
    const db = openDb()
    writeMigrationFile(
      '001_fails.js',
      `module.exports = {up: async db => { await db.schema.createTable('half', t => t.increments('id')); throw new Error('boom') }}`
    )

    await expect(instance(db).migrate()).rejects.toThrow('boom')

    expect(await db.schema.hasTable('half')).toBe(false)
    expect(await db('_odac_migrations').where('type', 'file')).toHaveLength(0)
  })

  it('runs files that opt out of the transaction on the plain connection', async () => {
    const db = openDb()
    writeMigrationFile(
      '001_plain.js',
      `module.exports = {transaction: false, up: async db => { await db.schema.createTable('plain_' + (db.isTransaction ? 'trx' : 'knex'), t => t.increments('id')) }}`
    )

    await instance(db).migrate()

    expect(await db.schema.hasTable('plain_knex')).toBe(true)
  })
})
