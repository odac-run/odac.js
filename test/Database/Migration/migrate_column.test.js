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

describe('Migration.migrate() - Foreign Key Diff', () => {
  it('should add a foreign key to an existing column', async () => {
    writeSchema('users', {columns: {id: {type: 'increments'}, name: {type: 'string'}}})
    writeSchema('posts', {columns: {id: {type: 'increments'}, user_id: {type: 'integer', unsigned: true}}})
    await Migration.migrate()

    writeSchema('posts', {
      columns: {
        id: {type: 'increments'},
        user_id: {type: 'integer', unsigned: true, references: {table: 'users', column: 'id'}, onDelete: 'CASCADE'}
      }
    })
    const result = await Migration.migrate()
    const fkOps = result.default.schema.filter(op => op.type === 'add_foreign_key')

    expect(fkOps).toEqual(expect.arrayContaining([expect.objectContaining({type: 'add_foreign_key', column: 'user_id', table: 'posts'})]))
  })

  it('should drop a foreign key removed from schema', async () => {
    writeSchema('users', {columns: {id: {type: 'increments'}, name: {type: 'string'}}})
    writeSchema('posts', {
      columns: {
        id: {type: 'increments'},
        user_id: {type: 'integer', unsigned: true, references: {table: 'users', column: 'id'}, onDelete: 'CASCADE'}
      }
    })
    await Migration.migrate()

    writeSchema('posts', {columns: {id: {type: 'increments'}, user_id: {type: 'integer', unsigned: true}}})
    const result = await Migration.migrate()
    const fkOps = result.default.schema.filter(op => op.type === 'drop_foreign_key')

    expect(fkOps).toEqual(expect.arrayContaining([expect.objectContaining({type: 'drop_foreign_key', column: 'user_id', table: 'posts'})]))
  })

  it('should replace a foreign key when onDelete action changes', async () => {
    writeSchema('users', {columns: {id: {type: 'increments'}, name: {type: 'string'}}})
    writeSchema('posts', {
      columns: {
        id: {type: 'increments'},
        user_id: {type: 'integer', unsigned: true, references: {table: 'users', column: 'id'}, onDelete: 'SET NULL'}
      }
    })
    await Migration.migrate()

    writeSchema('posts', {
      columns: {
        id: {type: 'increments'},
        user_id: {type: 'integer', unsigned: true, references: {table: 'users', column: 'id'}, onDelete: 'CASCADE'}
      }
    })
    const result = await Migration.migrate()
    const dropOps = result.default.schema.filter(op => op.type === 'drop_foreign_key')
    const addOps = result.default.schema.filter(op => op.type === 'add_foreign_key')

    expect(dropOps).toHaveLength(1)
    expect(addOps).toHaveLength(1)
    expect(addOps[0]).toMatchObject({column: 'user_id', table: 'posts'})
  })

  it('should not produce FK ops when references are unchanged', async () => {
    writeSchema('users', {columns: {id: {type: 'increments'}, name: {type: 'string'}}})
    writeSchema('posts', {
      columns: {
        id: {type: 'increments'},
        user_id: {type: 'integer', unsigned: true, references: {table: 'users', column: 'id'}, onDelete: 'CASCADE'}
      }
    })
    await Migration.migrate()

    const result = await Migration.migrate()
    const fkOps = result.default.schema.filter(op => op.type === 'add_foreign_key' || op.type === 'drop_foreign_key')

    expect(fkOps).toHaveLength(0)
  })

  it('should clean orphan rows before adding a foreign key constraint', async () => {
    writeSchema('users', {columns: {id: {type: 'increments'}, name: {type: 'string'}}})
    writeSchema('posts', {columns: {id: {type: 'increments'}, user_id: {type: 'integer', nullable: true}}})
    await Migration.migrate()

    // Insert a valid parent and an orphan child
    await db('users').insert({name: 'Alice'})
    await db('posts').insert({user_id: 1})
    await db('posts').insert({user_id: 999}) // orphan — user 999 does not exist

    // Now add FK constraint
    writeSchema('posts', {
      columns: {
        id: {type: 'increments'},
        user_id: {type: 'integer', nullable: true, references: {table: 'users', column: 'id'}, onDelete: 'CASCADE'}
      }
    })
    await Migration.migrate()

    // Orphan row should have user_id set to NULL (nullable column)
    const orphan = await db('posts').where('id', 2).first()
    expect(orphan.user_id).toBeNull()

    // Valid row should be untouched
    const valid = await db('posts').where('id', 1).first()
    expect(valid.user_id).toBe(1)
  })

  it('should skip FK and warn when non-nullable column has orphan rows', async () => {
    writeSchema('users', {columns: {id: {type: 'increments'}, name: {type: 'string'}}})
    writeSchema('posts', {columns: {id: {type: 'increments'}, user_id: {type: 'integer', nullable: false}}})
    await Migration.migrate()

    await db('users').insert({name: 'Alice'})
    await db('posts').insert({user_id: 1})
    await db('posts').insert({user_id: 999}) // orphan

    const warnSpy = jest.spyOn(console, 'error').mockImplementation(() => {})

    writeSchema('posts', {
      columns: {
        id: {type: 'increments'},
        user_id: {type: 'integer', nullable: false, references: {table: 'users', column: 'id'}, onDelete: 'CASCADE'}
      }
    })
    await Migration.migrate()

    // Orphan row must NOT be deleted — all data preserved
    const rows = await db('posts').select()
    expect(rows).toHaveLength(2)

    // Warning must have been emitted
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Skipping foreign key'))
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('1 orphan row(s)'))

    warnSpy.mockRestore()
  })
})

describe('Migration.migrate() - Column Type Change', () => {
  it('should alter a column when its type changes (string → text)', async () => {
    writeSchema('articles', {columns: {id: {type: 'increments'}, body: {type: 'string'}}})
    await Migration.migrate()

    writeSchema('articles', {columns: {id: {type: 'increments'}, body: {type: 'text'}}})
    const result = await Migration.migrate()
    const alterOps = result.default.schema.filter(op => op.type === 'alter_column')

    expect(alterOps).toEqual(expect.arrayContaining([expect.objectContaining({type: 'alter_column', column: 'body', table: 'articles'})]))
  })

  it('should alter a column when its type changes (integer → bigInteger)', async () => {
    writeSchema('counters', {columns: {id: {type: 'increments'}, value: {type: 'integer'}}})
    await Migration.migrate()

    writeSchema('counters', {columns: {id: {type: 'increments'}, value: {type: 'bigInteger'}}})
    const result = await Migration.migrate()
    const alterOps = result.default.schema.filter(op => op.type === 'alter_column')

    expect(alterOps).toEqual(expect.arrayContaining([expect.objectContaining({type: 'alter_column', column: 'value', table: 'counters'})]))
  })

  it('should not alter a column when its type is unchanged', async () => {
    writeSchema('logs', {columns: {id: {type: 'increments'}, message: {type: 'text'}}})
    await Migration.migrate()

    writeSchema('logs', {columns: {id: {type: 'increments'}, message: {type: 'text'}}})
    const result = await Migration.migrate()
    const alterOps = result.default.schema.filter(op => op.type === 'alter_column')

    expect(alterOps).toHaveLength(0)
  })

  it('should not produce alter for nanoid columns stored as string', async () => {
    writeSchema('tokens', {columns: {id: {type: 'nanoid', length: 21}, name: {type: 'string'}}})
    await Migration.migrate()

    // Re-run with same schema — nanoid maps to varchar in DB, should not trigger false alter
    writeSchema('tokens', {columns: {id: {type: 'nanoid', length: 21}, name: {type: 'string'}}})
    const result = await Migration.migrate()
    const alterOps = result.default.schema.filter(op => op.type === 'alter_column')

    expect(alterOps).toHaveLength(0)
  })
})

describe('Migration.migrate() - Nullable Preservation on Alter', () => {
  it('should preserve NOT NULL when altering a column that has no explicit nullable in schema', async () => {
    // Create table with a NOT NULL column
    writeSchema('domains', {columns: {id: {type: 'increments'}, code: {type: 'string', nullable: false, default: 'A'}}})
    await Migration.migrate()

    // Change default value but omit nullable — should preserve NOT NULL from DB
    writeSchema('domains', {columns: {id: {type: 'increments'}, code: {type: 'string', default: 'B'}}})
    const result = await Migration.migrate()
    const alterOps = result.default.schema.filter(op => op.type === 'alter_column')

    expect(alterOps).toHaveLength(1)
    expect(alterOps[0]).toMatchObject({column: 'code', currentNullable: false})
  })

  it('should preserve NULLABLE when altering a column that has no explicit nullable in schema', async () => {
    // Create table with a NULLABLE column
    writeSchema('logs', {columns: {id: {type: 'increments'}, note: {type: 'string', nullable: true, default: 'x'}}})
    await Migration.migrate()

    // Change default but omit nullable — should preserve nullable from DB
    writeSchema('logs', {columns: {id: {type: 'increments'}, note: {type: 'string', default: 'y'}}})
    const result = await Migration.migrate()
    const alterOps = result.default.schema.filter(op => op.type === 'alter_column')

    expect(alterOps).toHaveLength(1)
    expect(alterOps[0]).toMatchObject({column: 'note', currentNullable: true})
  })
})
