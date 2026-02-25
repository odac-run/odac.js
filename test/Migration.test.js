'use strict'

const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const knex = require('knex')

const Migration = require('../src/Database/Migration')

/**
 * Migration Engine integration tests.
 * Uses SQLite in-memory for true isolation — no external DB required.
 */

let db
let tmpDir

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'odac-migration-'))

  db = knex({
    client: 'sqlite3',
    connection: {filename: ':memory:'},
    useNullAsDefault: true
  })

  Migration.init(tmpDir, {default: db})
})

afterEach(async () => {
  await db.destroy()
  fs.rmSync(tmpDir, {recursive: true, force: true})
})

// ---------------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------------

function writeSchema(name, content, subDir) {
  const dir = subDir ? path.join(tmpDir, 'schema', subDir) : path.join(tmpDir, 'schema')
  fs.mkdirSync(dir, {recursive: true})
  fs.writeFileSync(path.join(dir, `${name}.js`), `module.exports = ${JSON.stringify(content, null, 2)}`)
}

function writeMigrationFile(name, upFn, downFn, subDir) {
  const dir = subDir ? path.join(tmpDir, 'migration', subDir) : path.join(tmpDir, 'migration')
  fs.mkdirSync(dir, {recursive: true})

  const content = `
    module.exports = {
      up: ${upFn.toString()},
      down: ${downFn ? downFn.toString() : 'undefined'}
    }
  `
  fs.writeFileSync(path.join(dir, name), content)
}

// ---------------------------------------------------------------------------
// TABLE CREATION
// ---------------------------------------------------------------------------

describe('Migration Engine', () => {
  describe('Table Creation', () => {
    it('should create a new table from a schema file', async () => {
      writeSchema('products', {
        columns: {
          id: {type: 'increments'},
          name: {type: 'string', length: 100, nullable: false},
          price: {type: 'decimal', precision: 10, scale: 2},
          is_active: {type: 'boolean', default: true}
        },
        indexes: []
      })

      const result = await Migration.migrate()
      const ops = result.default.schema

      expect(ops).toEqual(expect.arrayContaining([expect.objectContaining({type: 'create_table', table: 'products'})]))

      const exists = await db.schema.hasTable('products')
      expect(exists).toBe(true)

      const info = await db('products').columnInfo()
      expect(info).toHaveProperty('id')
      expect(info).toHaveProperty('name')
      expect(info).toHaveProperty('price')
      expect(info).toHaveProperty('is_active')
    })

    it('should create a table with timestamps virtual type', async () => {
      writeSchema('logs', {
        columns: {
          id: {type: 'increments'},
          message: {type: 'text'},
          timestamps: {type: 'timestamps'}
        },
        indexes: []
      })

      await Migration.migrate()

      const info = await db('logs').columnInfo()
      expect(info).toHaveProperty('created_at')
      expect(info).toHaveProperty('updated_at')
    })

    it('should create a table with indexes', async () => {
      writeSchema('users', {
        columns: {
          id: {type: 'increments'},
          email: {type: 'string', length: 255, nullable: false},
          role: {type: 'string', length: 50}
        },
        indexes: [{columns: ['email'], unique: true}, {columns: ['role']}]
      })

      await Migration.migrate()

      const exists = await db.schema.hasTable('users')
      expect(exists).toBe(true)
    })

    it('should skip creation if table already exists', async () => {
      writeSchema('existing', {
        columns: {
          id: {type: 'increments'},
          name: {type: 'string'}
        },
        indexes: []
      })

      await Migration.migrate()
      const result2 = await Migration.migrate()

      // Second run should not try to create again
      const createOps = result2.default.schema.filter(op => op.type === 'create_table')
      expect(createOps).toHaveLength(0)
    })
  })

  // ---------------------------------------------------------------------------
  // COLUMN DIFF
  // ---------------------------------------------------------------------------

  describe('Column Diff', () => {
    it('should add a new column to an existing table', async () => {
      writeSchema('posts', {
        columns: {
          id: {type: 'increments'},
          title: {type: 'string'}
        },
        indexes: []
      })

      await Migration.migrate()

      // Now add a column
      writeSchema('posts', {
        columns: {
          id: {type: 'increments'},
          title: {type: 'string'},
          body: {type: 'text', nullable: true}
        },
        indexes: []
      })

      const result = await Migration.migrate()
      const addOps = result.default.schema.filter(op => op.type === 'add_column')

      expect(addOps).toEqual(expect.arrayContaining([expect.objectContaining({type: 'add_column', column: 'body', table: 'posts'})]))

      const info = await db('posts').columnInfo()
      expect(info).toHaveProperty('body')
    })

    it('should drop a column removed from schema', async () => {
      writeSchema('items', {
        columns: {
          id: {type: 'increments'},
          name: {type: 'string'},
          obsolete: {type: 'string'}
        },
        indexes: []
      })

      await Migration.migrate()

      // Remove the obsolete column
      writeSchema('items', {
        columns: {
          id: {type: 'increments'},
          name: {type: 'string'}
        },
        indexes: []
      })

      const result = await Migration.migrate()
      const dropOps = result.default.schema.filter(op => op.type === 'drop_column')

      expect(dropOps).toEqual(expect.arrayContaining([expect.objectContaining({type: 'drop_column', column: 'obsolete', table: 'items'})]))
    })
  })

  // ---------------------------------------------------------------------------
  // INDEX DIFF
  // ---------------------------------------------------------------------------

  describe('Index Diff', () => {
    it('should add a new index to an existing table', async () => {
      writeSchema('articles', {
        columns: {
          id: {type: 'increments'},
          slug: {type: 'string', length: 255},
          status: {type: 'string', length: 50}
        },
        indexes: []
      })

      await Migration.migrate()

      writeSchema('articles', {
        columns: {
          id: {type: 'increments'},
          slug: {type: 'string', length: 255},
          status: {type: 'string', length: 50}
        },
        indexes: [{columns: ['slug'], unique: true}]
      })

      const result = await Migration.migrate()
      const indexOps = result.default.schema.filter(op => op.type === 'add_index')

      expect(indexOps).toHaveLength(1)
      expect(indexOps[0].index.columns).toEqual(['slug'])
      expect(indexOps[0].index.unique).toBe(true)
    })

    it('should drop an index removed from schema', async () => {
      writeSchema('tags', {
        columns: {
          id: {type: 'increments'},
          name: {type: 'string', length: 100}
        },
        indexes: [{columns: ['name'], unique: false}]
      })

      await Migration.migrate()

      writeSchema('tags', {
        columns: {
          id: {type: 'increments'},
          name: {type: 'string', length: 100}
        },
        indexes: []
      })

      const result = await Migration.migrate()
      const dropIndexOps = result.default.schema.filter(op => op.type === 'drop_index')

      expect(dropIndexOps.length).toBeGreaterThanOrEqual(1)
    })
  })

  // ---------------------------------------------------------------------------
  // SEED DATA
  // ---------------------------------------------------------------------------

  describe('Seed Data', () => {
    it('should insert seed data on first migrate', async () => {
      writeSchema('roles', {
        columns: {
          id: {type: 'increments'},
          name: {type: 'string', length: 50},
          level: {type: 'integer', default: 0}
        },
        indexes: [],
        seed: [
          {name: 'admin', level: 100},
          {name: 'user', level: 1}
        ],
        seedKey: 'name'
      })

      const result = await Migration.migrate()

      expect(result.default.seeds).toEqual(
        expect.arrayContaining([
          expect.objectContaining({type: 'seed_insert', table: 'roles', key: 'admin'}),
          expect.objectContaining({type: 'seed_insert', table: 'roles', key: 'user'})
        ])
      )

      const rows = await db('roles').select()
      expect(rows).toHaveLength(2)
      expect(rows.find(r => r.name === 'admin').level).toBe(100)
    })

    it('should update seed data if values changed', async () => {
      writeSchema('settings', {
        columns: {
          id: {type: 'increments'},
          key: {type: 'string', length: 100},
          value: {type: 'string', length: 255}
        },
        indexes: [],
        seed: [{key: 'site_name', value: 'My App'}],
        seedKey: 'key'
      })

      await Migration.migrate()

      // Update the seed value
      writeSchema('settings', {
        columns: {
          id: {type: 'increments'},
          key: {type: 'string', length: 100},
          value: {type: 'string', length: 255}
        },
        indexes: [],
        seed: [{key: 'site_name', value: 'New App Name'}],
        seedKey: 'key'
      })

      const result = await Migration.migrate()

      expect(result.default.seeds).toEqual(
        expect.arrayContaining([expect.objectContaining({type: 'seed_update', table: 'settings', key: 'site_name'})])
      )

      const row = await db('settings').where('key', 'site_name').first()
      expect(row.value).toBe('New App Name')
    })

    it('should not re-insert existing seed data', async () => {
      writeSchema('statuses', {
        columns: {
          id: {type: 'increments'},
          name: {type: 'string', length: 50}
        },
        indexes: [],
        seed: [{name: 'active'}, {name: 'inactive'}],
        seedKey: 'name'
      })

      await Migration.migrate()
      const result2 = await Migration.migrate()

      // Seeds should have nothing to do second time
      expect(result2.default.seeds).toHaveLength(0)
    })

    it('should throw if seed exists but seedKey is missing', async () => {
      writeSchema('bad_seed', {
        columns: {
          id: {type: 'increments'},
          name: {type: 'string'}
        },
        indexes: [],
        seed: [{name: 'oops'}]
      })

      await expect(Migration.migrate()).rejects.toThrow('seedKey')
    })
  })

  // ---------------------------------------------------------------------------
  // IMPERATIVE MIGRATION FILES
  // ---------------------------------------------------------------------------

  describe('Migration Files', () => {
    it('should run pending migration files in order', async () => {
      // Create a table first
      await db.schema.createTable('counters', t => {
        t.increments('id')
        t.string('name')
        t.integer('value').defaultTo(0)
      })

      writeMigrationFile(
        '20260225_001_init_counters.js',
        async function up(db) {
          await db('counters').insert({name: 'visits', value: 0})
        },
        async function down(db) {
          await db('counters').where('name', 'visits').del()
        }
      )

      writeMigrationFile(
        '20260225_002_add_counter.js',
        async function up(db) {
          await db('counters').insert({name: 'signups', value: 0})
        },
        async function down(db) {
          await db('counters').where('name', 'signups').del()
        }
      )

      const result = await Migration.migrate()
      const fileOps = result.default.files

      expect(fileOps).toHaveLength(2)
      expect(fileOps[0].name).toBe('20260225_001_init_counters.js')
      expect(fileOps[1].name).toBe('20260225_002_add_counter.js')

      const rows = await db('counters').select()
      expect(rows).toHaveLength(2)
    })

    it('should not re-run already applied migration files', async () => {
      await db.schema.createTable('data', t => {
        t.increments('id')
        t.string('value')
      })

      writeMigrationFile('20260225_001_insert.js', async function up(db) {
        await db('data').insert({value: 'test'})
      })

      await Migration.migrate()
      const result2 = await Migration.migrate()

      expect(result2.default.files).toHaveLength(0)

      const rows = await db('data').select()
      expect(rows).toHaveLength(1) // Only inserted once
    })

    it('should throw if migration file has no up function', async () => {
      const dir = path.join(tmpDir, 'migration')
      fs.mkdirSync(dir, {recursive: true})
      fs.writeFileSync(path.join(dir, '20260225_001_bad.js'), 'module.exports = {}')

      await expect(Migration.migrate()).rejects.toThrow("missing an 'up' function")
    })
  })

  // ---------------------------------------------------------------------------
  // ROLLBACK
  // ---------------------------------------------------------------------------

  describe('Rollback', () => {
    it('should rollback the last batch', async () => {
      await db.schema.createTable('entries', t => {
        t.increments('id')
        t.string('name')
      })

      writeMigrationFile(
        '20260225_001_add_entry.js',
        async function up(db) {
          await db('entries').insert({name: 'first'})
        },
        async function down(db) {
          await db('entries').where('name', 'first').del()
        }
      )

      await Migration.migrate()

      const before = await db('entries').select()
      expect(before).toHaveLength(1)

      const result = await Migration.rollback()

      expect(result.default).toEqual(
        expect.arrayContaining([expect.objectContaining({type: 'rolled_back', name: '20260225_001_add_entry.js'})])
      )

      const after = await db('entries').select()
      expect(after).toHaveLength(0)
    })
  })

  // ---------------------------------------------------------------------------
  // DRY RUN (STATUS)
  // ---------------------------------------------------------------------------

  describe('Status (Dry Run)', () => {
    it('should show pending changes without applying them', async () => {
      writeSchema('preview', {
        columns: {
          id: {type: 'increments'},
          name: {type: 'string'}
        },
        indexes: []
      })

      const result = await Migration.status()

      expect(result.default.schema).toEqual(expect.arrayContaining([expect.objectContaining({type: 'create_table', table: 'preview'})]))

      // Table should NOT exist (dry-run)
      const exists = await db.schema.hasTable('preview')
      expect(exists).toBe(false)
    })
  })

  // ---------------------------------------------------------------------------
  // SNAPSHOT
  // ---------------------------------------------------------------------------

  describe('Snapshot', () => {
    it('should reverse-engineer existing tables into schema files', async () => {
      await db.schema.createTable('customers', t => {
        t.increments('id')
        t.string('name', 100)
        t.string('email', 255)
        t.boolean('vip').defaultTo(false)
      })

      const result = await Migration.snapshot()
      const files = result.default

      expect(files.length).toBeGreaterThanOrEqual(1)

      const customerFile = files.find(f => f.includes('customers'))
      expect(customerFile).toBeDefined()
      expect(fs.existsSync(customerFile)).toBe(true)

      const content = fs.readFileSync(customerFile, 'utf8')
      expect(content).toContain("'customers'")
      expect(content).toContain('columns')
    })

    it('should skip the tracking table in snapshot', async () => {
      writeSchema('dummy', {
        columns: {id: {type: 'increments'}},
        indexes: []
      })
      await Migration.migrate()

      const result = await Migration.snapshot()
      const files = result.default

      const trackingFile = files.find(f => f.includes('_odac_migrations'))
      expect(trackingFile).toBeUndefined()
    })
  })

  // ---------------------------------------------------------------------------
  // MULTI-DATABASE
  // ---------------------------------------------------------------------------

  describe('Multi-Database', () => {
    let analyticsDb

    beforeEach(async () => {
      analyticsDb = knex({
        client: 'sqlite3',
        connection: {filename: ':memory:'},
        useNullAsDefault: true
      })

      Migration.init(tmpDir, {default: db, analytics: analyticsDb})
    })

    afterEach(async () => {
      await analyticsDb.destroy()
    })

    it('should migrate different schemas to different connections', async () => {
      writeSchema('users', {
        columns: {id: {type: 'increments'}, name: {type: 'string'}},
        indexes: []
      })

      writeSchema(
        'events',
        {
          columns: {id: {type: 'increments'}, action: {type: 'string'}},
          indexes: []
        },
        'analytics'
      )

      const result = await Migration.migrate()

      // users only on default
      const defaultExists = await db.schema.hasTable('users')
      expect(defaultExists).toBe(true)

      // events only on analytics
      const analyticsExists = await analyticsDb.schema.hasTable('events')
      expect(analyticsExists).toBe(true)

      // Cross-check: events should NOT be on default
      const crossCheck = await db.schema.hasTable('events')
      expect(crossCheck).toBe(false)
    })

    it('should migrate only targeted db with --db flag', async () => {
      writeSchema('alpha', {
        columns: {id: {type: 'increments'}},
        indexes: []
      })

      writeSchema(
        'beta',
        {
          columns: {id: {type: 'increments'}},
          indexes: []
        },
        'analytics'
      )

      const result = await Migration.migrate({db: 'analytics'})

      // Only analytics should be in the result
      expect(result).toHaveProperty('analytics')
      expect(result).not.toHaveProperty('default')

      // beta should exist on analytics
      const betaExists = await analyticsDb.schema.hasTable('beta')
      expect(betaExists).toBe(true)

      // alpha should NOT exist on default (wasn't targeted)
      const alphaExists = await db.schema.hasTable('alpha')
      expect(alphaExists).toBe(false)
    })

    it('should throw for unknown connection key', async () => {
      await expect(Migration.migrate({db: 'nonexistent'})).rejects.toThrow('Unknown database connection')
    })
  })

  // ---------------------------------------------------------------------------
  // TRACKING TABLE
  // ---------------------------------------------------------------------------

  describe('Tracking Table', () => {
    it('should auto-create the tracking table on first run', async () => {
      writeSchema('first', {
        columns: {id: {type: 'increments'}},
        indexes: []
      })

      await Migration.migrate()

      const exists = await db.schema.hasTable('_odac_migrations')
      expect(exists).toBe(true)
    })
  })

  // ---------------------------------------------------------------------------
  // EDGE CASES
  // ---------------------------------------------------------------------------

  describe('Edge Cases', () => {
    it('should handle empty schema directory gracefully', async () => {
      const result = await Migration.migrate()

      expect(result.default.schema).toHaveLength(0)
      expect(result.default.files).toHaveLength(0)
      expect(result.default.seeds).toHaveLength(0)
    })

    it('should handle multiple column types correctly', async () => {
      writeSchema('all_types', {
        columns: {
          id: {type: 'increments'},
          big_id: {type: 'bigInteger'},
          score: {type: 'float'},
          amount: {type: 'decimal', precision: 12, scale: 4},
          label: {type: 'string', length: 50},
          body: {type: 'text'},
          active: {type: 'boolean'},
          born_on: {type: 'date'},
          login_at: {type: 'datetime'},
          meta: {type: 'json'},
          uid: {type: 'uuid'}
        },
        indexes: []
      })

      await Migration.migrate()

      const info = await db('all_types').columnInfo()
      expect(Object.keys(info)).toHaveLength(11)
    })

    it('should handle foreign key references', async () => {
      writeSchema('categories', {
        columns: {
          id: {type: 'increments'},
          name: {type: 'string'}
        },
        indexes: []
      })

      writeSchema('products', {
        columns: {
          id: {type: 'increments'},
          name: {type: 'string'},
          category_id: {
            type: 'integer',
            unsigned: true,
            references: {table: 'categories', column: 'id'},
            onDelete: 'CASCADE'
          }
        },
        indexes: []
      })

      await Migration.migrate()

      const catExists = await db.schema.hasTable('categories')
      const prodExists = await db.schema.hasTable('products')
      expect(catExists).toBe(true)
      expect(prodExists).toBe(true)
    })
  })
})
