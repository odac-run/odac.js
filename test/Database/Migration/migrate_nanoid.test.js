'use strict'

const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const knex = require('knex')
const Migration = require('../../../src/Database/Migration')

let db, tmpDir

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'odac-migration-nanoid-'))
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

describe('Migration - NanoID Column Type', () => {
  it('should create a nanoid column as string(21) by default', async () => {
    writeSchema('tokens', {
      columns: {
        id: {type: 'nanoid', primary: true},
        name: {type: 'string', length: 100}
      }
    })

    await Migration.migrate()
    const exists = await db.schema.hasTable('tokens')
    expect(exists).toBe(true)

    const info = await db('tokens').columnInfo()
    expect(info).toHaveProperty('id')
    expect(info.id.type).toBe('varchar')
    expect(Number(info.id.maxLength)).toBe(21)
  })

  it('should support custom length for nanoid column', async () => {
    writeSchema('short_ids', {
      columns: {
        id: {type: 'nanoid', length: 12, primary: true},
        label: {type: 'string'}
      }
    })

    await Migration.migrate()
    const info = await db('short_ids').columnInfo()
    expect(Number(info.id.maxLength)).toBe(12)
  })

  it('should auto-generate nanoid for seed data', async () => {
    writeSchema('articles', {
      columns: {
        id: {type: 'nanoid', primary: true},
        title: {type: 'string', length: 255},
        slug: {type: 'string', length: 255}
      },
      seed: [{title: 'Hello World', slug: 'hello-world'}],
      seedKey: 'slug'
    })

    await Migration.migrate()
    const row = await db('articles').where('slug', 'hello-world').first()

    expect(row).toBeDefined()
    expect(row.id).toBeDefined()
    expect(typeof row.id).toBe('string')
    expect(row.id.length).toBe(21)
    expect(row.id).toMatch(/^[a-zA-Z0-9]+$/)
  })

  it('should not overwrite nanoid if seed data provides it explicitly', async () => {
    writeSchema('tags', {
      columns: {
        id: {type: 'nanoid', primary: true},
        name: {type: 'string', length: 100}
      },
      seed: [{id: 'EXPLICIT_ID_12345678', name: 'featured'}],
      seedKey: 'name'
    })

    await Migration.migrate()
    const row = await db('tags').where('name', 'featured').first()

    expect(row.id).toBe('EXPLICIT_ID_12345678')
  })

  it('should preserve nanoid value on subsequent seed runs (idempotent)', async () => {
    writeSchema('categories', {
      columns: {
        id: {type: 'nanoid', primary: true},
        name: {type: 'string', length: 100}
      },
      seed: [{name: 'tech'}],
      seedKey: 'name'
    })

    await Migration.migrate()
    const firstRow = await db('categories').where('name', 'tech').first()
    const firstId = firstRow.id

    // Run migrate again — should not change the ID
    await Migration.migrate()
    const secondRow = await db('categories').where('name', 'tech').first()

    expect(secondRow.id).toBe(firstId)
  })

  it('should respect custom length in seed nanoid generation', async () => {
    writeSchema('codes', {
      columns: {
        code: {type: 'nanoid', length: 8, primary: true},
        label: {type: 'string', length: 50}
      },
      seed: [{label: 'discount-10'}],
      seedKey: 'label'
    })

    await Migration.migrate()
    const row = await db('codes').where('label', 'discount-10').first()

    expect(row.code).toBeDefined()
    expect(row.code.length).toBe(8)
  })

  it('should add nanoid column to existing table via diff', async () => {
    writeSchema('events', {
      columns: {
        id: {type: 'increments'},
        name: {type: 'string'}
      }
    })
    await Migration.migrate()

    writeSchema('events', {
      columns: {
        id: {type: 'increments'},
        public_id: {type: 'nanoid', length: 16},
        name: {type: 'string'}
      }
    })

    const result = await Migration.migrate()
    const addOps = result.default.schema.filter(op => op.type === 'add_column')
    expect(addOps).toEqual(expect.arrayContaining([expect.objectContaining({type: 'add_column', column: 'public_id'})]))

    const info = await db('events').columnInfo()
    expect(info).toHaveProperty('public_id')
    expect(Number(info.public_id.maxLength)).toBe(16)
  })
})
