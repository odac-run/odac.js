'use strict'

const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const knex = require('knex')
const Migration = require('../../../src/Database/Migration')

// In production the schema diff must not drop or narrow columns unless explicitly allowed:
// a rename, a rollback to an older release or an old instance restarting during a rolling
// deploy would otherwise delete data on boot.

let db, tmpDir, originalEnv

beforeEach(async () => {
  originalEnv = process.env.NODE_ENV
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'odac-migration-destructive-'))
  db = knex({client: 'sqlite3', connection: {filename: ':memory:'}, useNullAsDefault: true})
  Migration.init(tmpDir, {default: db})
  jest.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(async () => {
  process.env.NODE_ENV = originalEnv
  delete global.Odac
  jest.restoreAllMocks()
  await db.destroy()
  fs.rmSync(tmpDir, {recursive: true, force: true})
})

function writeSchema(name, content) {
  const dir = path.join(tmpDir, 'schema')
  fs.mkdirSync(dir, {recursive: true})
  fs.writeFileSync(path.join(dir, `${name}.js`), `module.exports = ${JSON.stringify(content, null, 2)}`)
  delete require.cache[path.join(dir, `${name}.js`)]
}

async function createItems() {
  writeSchema('items', {columns: {id: {type: 'increments'}, name: {type: 'string', length: 100}, legacy: {type: 'string', nullable: true}}})
  await Migration.migrate()
  await db('items').insert({name: 'kept', legacy: 'precious'})
}

describe('Migration.migrate() - destructive changes', () => {
  it('skips dropping a column in production and keeps its data', async () => {
    await createItems()
    process.env.NODE_ENV = 'production'

    writeSchema('items', {columns: {id: {type: 'increments'}, name: {type: 'string', length: 100}}})
    const result = await Migration.migrate()

    expect(result.default.schema).toEqual([expect.objectContaining({type: 'drop_column', column: 'legacy', skipped: 'destructive'})])
    expect((await db('items').first()).legacy).toBe('precious')
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('drop_column items.legacy'))
  })

  it('drops the column when allowDestructive is passed', async () => {
    await createItems()
    process.env.NODE_ENV = 'production'

    writeSchema('items', {columns: {id: {type: 'increments'}, name: {type: 'string', length: 100}}})
    await Migration.migrate({allowDestructive: true})

    expect(await db('items').columnInfo()).not.toHaveProperty('legacy')
  })

  it('drops the column when migration.allowDestructive is configured', async () => {
    await createItems()
    process.env.NODE_ENV = 'production'
    global.Odac = {Config: {migration: {allowDestructive: true}}}

    writeSchema('items', {columns: {id: {type: 'increments'}, name: {type: 'string', length: 100}}})
    await Migration.migrate()

    expect(await db('items').columnInfo()).not.toHaveProperty('legacy')
  })

  it('keeps applying schema changes outside production', async () => {
    await createItems()
    process.env.NODE_ENV = 'development'

    writeSchema('items', {columns: {id: {type: 'increments'}, name: {type: 'string', length: 100}}})
    await Migration.migrate()

    expect(await db('items').columnInfo()).not.toHaveProperty('legacy')
  })

  it('skips type changes and shorter lengths but applies safe changes in production', async () => {
    await createItems()
    process.env.NODE_ENV = 'production'

    writeSchema('items', {
      columns: {
        id: {type: 'increments'},
        name: {type: 'string', length: 20},
        legacy: {type: 'integer', nullable: true},
        extra: {type: 'string', nullable: true}
      }
    })
    const result = await Migration.migrate()

    const skipped = result.default.schema.filter(op => op.skipped).map(op => `${op.type}:${op.column}`)
    expect(skipped.sort()).toEqual(['alter_column:legacy', 'alter_column:name'])
    expect(await db('items').columnInfo()).toHaveProperty('extra')
    expect((await db('items').first()).legacy).toBe('precious')
  })

  it('treats a longer length as a safe alter', async () => {
    await createItems()
    process.env.NODE_ENV = 'production'

    writeSchema('items', {
      columns: {id: {type: 'increments'}, name: {type: 'string', length: 255}, legacy: {type: 'string', nullable: true}}
    })
    const result = await Migration.migrate()

    expect(result.default.schema).toEqual([expect.objectContaining({type: 'alter_column', column: 'name', narrowing: false})])
    expect(result.default.schema[0].skipped).toBeUndefined()
  })

  it('reports skipped operations in a dry run without warning', async () => {
    await createItems()
    process.env.NODE_ENV = 'production'
    console.warn.mockClear()

    writeSchema('items', {columns: {id: {type: 'increments'}, name: {type: 'string', length: 100}}})
    const result = await Migration.status()

    expect(result.default.schema).toEqual([expect.objectContaining({type: 'drop_column', skipped: 'destructive'})])
    expect(console.warn).not.toHaveBeenCalled()
  })
})
