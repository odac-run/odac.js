'use strict'

const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const Migration = require('../../../src/Database/Migration')

let tmpDir

/**
 * Minimal in-memory ClickHouse adapter double. Tracks which tables "exist", records executed
 * DDL and inserts, and lets each test drive columnInfo/query results.
 */
function makeFakeAdapter(existingTables = []) {
  const tables = new Set(existingTables)
  return {
    _odacDialect: 'clickhouse',
    _odacConnectionKey: 'default',
    client: {config: {client: 'clickhouse'}},
    execs: [],
    inserts: [],
    _columnInfo: {},
    _queryHandler: () => [],
    hasTable: jest.fn(async name => tables.has(name)),
    exec: jest.fn(async function (sql) {
      this.execs.push(sql)
      const created = sql.match(/CREATE TABLE IF NOT EXISTS `([^`]+)`/)
      if (created) tables.add(created[1])
    }),
    insert: jest.fn(async function (table, rows) {
      this.inserts.push({table, rows})
    }),
    query: jest.fn(async function (sql) {
      return this._queryHandler(sql)
    }),
    columnInfo: jest.fn(async function (table) {
      return this._columnInfo[table] || {}
    })
  }
}

function writeSchema(name, content, connection) {
  const dir = connection ? path.join(tmpDir, 'schema', connection) : path.join(tmpDir, 'schema')
  fs.mkdirSync(dir, {recursive: true})
  fs.writeFileSync(path.join(dir, `${name}.js`), `module.exports = ${JSON.stringify(content)}`)
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'odac-ch-migration-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, {recursive: true, force: true})
})

describe('Migration ClickHouse pipeline', () => {
  it('creates a missing table with engine-aware DDL', async () => {
    const conn = makeFakeAdapter([])
    Migration.init(tmpDir, {default: conn})
    writeSchema('events', {
      engine: 'MergeTree',
      orderBy: ['created_at', 'id'],
      columns: {id: {type: 'nanoid'}, created_at: {type: 'datetime'}}
    })

    const summary = await Migration.migrate()

    expect(summary.default.schema).toEqual([expect.objectContaining({type: 'create_table', table: 'events'})])
    const createDDL = conn.execs.find(s => s.includes('CREATE TABLE IF NOT EXISTS `events`'))
    expect(createDDL).toContain('ENGINE = MergeTree()')
    expect(createDDL).toContain('ORDER BY (`created_at`, `id`)')
  })

  it('adds only missing columns on an existing table', async () => {
    const conn = makeFakeAdapter(['_odac_migrations', 'events'])
    conn._columnInfo['events'] = {id: {type: 'String'}, created_at: {type: 'DateTime'}}
    Migration.init(tmpDir, {default: conn})
    writeSchema('events', {
      engine: 'MergeTree',
      orderBy: 'id',
      columns: {id: {type: 'nanoid'}, created_at: {type: 'datetime'}, source: {type: 'string', nullable: true}}
    })

    const summary = await Migration.migrate()

    expect(summary.default.schema).toEqual([expect.objectContaining({type: 'add_column', table: 'events', column: 'source'})])
    const addDDL = conn.execs.find(s => s.includes('ALTER TABLE `events` ADD COLUMN'))
    expect(addDDL).toBe('ALTER TABLE `events` ADD COLUMN IF NOT EXISTS `source` Nullable(String)')
  })

  it('dry-run computes operations without executing DDL', async () => {
    const conn = makeFakeAdapter([])
    Migration.init(tmpDir, {default: conn})
    writeSchema('events', {orderBy: 'id', columns: {id: {type: 'integer'}}})

    const summary = await Migration.status()

    expect(summary.default.schema).toEqual([expect.objectContaining({type: 'create_table', table: 'events'})])
    expect(conn.execs.some(s => s.startsWith('CREATE TABLE'))).toBe(false)
  })

  it('seeds insert-only, skipping rows that already exist', async () => {
    const conn = makeFakeAdapter(['_odac_migrations', 'countries'])
    conn._columnInfo['countries'] = {code: {type: 'String'}, name: {type: 'String'}}
    // First seed row exists (returns a row), second does not (returns []).
    conn._queryHandler = sql => {
      if (sql.includes("`code` = 'TR'")) return [{1: 1}]
      return []
    }
    Migration.init(tmpDir, {default: conn})
    writeSchema('countries', {
      engine: 'MergeTree',
      orderBy: 'code',
      columns: {code: {type: 'string'}, name: {type: 'string'}},
      seedKey: 'code',
      seed: [
        {code: 'TR', name: 'Türkiye'},
        {code: 'DE', name: 'Germany'}
      ]
    })

    const summary = await Migration.migrate()

    expect(summary.default.seeds).toEqual([expect.objectContaining({type: 'seed_insert', table: 'countries', key: 'DE'})])
    expect(conn.inserts).toEqual([{table: 'countries', rows: [{code: 'DE', name: 'Germany'}]}])
  })

  it('records the initial TTL when creating a table with a ttl field', async () => {
    const conn = makeFakeAdapter([])
    Migration.init(tmpDir, {default: conn})
    writeSchema('events', {
      engine: 'MergeTree',
      orderBy: 'created_at',
      ttl: 'created_at + INTERVAL 30 DAY',
      columns: {id: {type: 'nanoid'}, created_at: {type: 'datetime'}}
    })

    await Migration.migrate()

    const createDDL = conn.execs.find(s => s.includes('CREATE TABLE IF NOT EXISTS `events`'))
    expect(createDDL).toContain('TTL created_at + INTERVAL 30 DAY')
    expect(conn.inserts).toEqual([
      {
        table: '_odac_migrations',
        rows: [{name: 'events', connection: 'default', type: 'ttl', batch: 1, value: 'created_at + INTERVAL 30 DAY'}]
      }
    ])
  })

  it('issues MODIFY TTL when the schema ttl differs from the last-applied one', async () => {
    const conn = makeFakeAdapter(['_odac_migrations', 'events'])
    conn._columnInfo['_odac_migrations'] = {name: {}, connection: {}, type: {}, batch: {}, value: {}, applied_at: {}}
    conn._columnInfo['events'] = {id: {type: 'String'}, created_at: {type: 'DateTime'}}
    conn._queryHandler = sql => {
      if (sql.includes("type = 'ttl'")) return [{value: 'created_at + INTERVAL 7 DAY', batch: 1}]
      return []
    }
    Migration.init(tmpDir, {default: conn})
    writeSchema('events', {
      engine: 'MergeTree',
      orderBy: 'created_at',
      ttl: 'created_at + INTERVAL 30 DAY',
      columns: {id: {type: 'nanoid'}, created_at: {type: 'datetime'}}
    })

    const summary = await Migration.migrate()

    expect(summary.default.schema).toEqual([
      expect.objectContaining({type: 'modify_ttl', table: 'events', ttl: 'created_at + INTERVAL 30 DAY'})
    ])
    expect(conn.execs).toContain('ALTER TABLE `events` MODIFY TTL created_at + INTERVAL 30 DAY')
    expect(conn.inserts).toEqual([
      {
        table: '_odac_migrations',
        rows: [{name: 'events', connection: 'default', type: 'ttl', batch: 2, value: 'created_at + INTERVAL 30 DAY'}]
      }
    ])
  })

  it('does not touch TTL when the schema matches the last-applied expression', async () => {
    const conn = makeFakeAdapter(['_odac_migrations', 'events'])
    conn._columnInfo['_odac_migrations'] = {name: {}, connection: {}, type: {}, batch: {}, value: {}, applied_at: {}}
    conn._columnInfo['events'] = {id: {type: 'String'}, created_at: {type: 'DateTime'}}
    conn._queryHandler = sql => {
      if (sql.includes("type = 'ttl'")) return [{value: 'created_at + INTERVAL 30 DAY', batch: 1}]
      return []
    }
    Migration.init(tmpDir, {default: conn})
    writeSchema('events', {
      engine: 'MergeTree',
      orderBy: 'created_at',
      ttl: 'created_at + INTERVAL 30 DAY',
      columns: {id: {type: 'nanoid'}, created_at: {type: 'datetime'}}
    })

    const summary = await Migration.migrate()

    expect(summary.default.schema).toEqual([])
    expect(conn.execs.some(s => s.includes('MODIFY TTL') || s.includes('REMOVE TTL'))).toBe(false)
    expect(conn.inserts).toEqual([])
  })

  it('issues REMOVE TTL when the schema drops a previously applied ttl', async () => {
    const conn = makeFakeAdapter(['_odac_migrations', 'events'])
    conn._columnInfo['_odac_migrations'] = {name: {}, connection: {}, type: {}, batch: {}, value: {}, applied_at: {}}
    conn._columnInfo['events'] = {id: {type: 'String'}, created_at: {type: 'DateTime'}}
    conn._queryHandler = sql => {
      if (sql.includes("type = 'ttl'")) return [{value: 'created_at + INTERVAL 30 DAY', batch: 3}]
      return []
    }
    Migration.init(tmpDir, {default: conn})
    writeSchema('events', {
      engine: 'MergeTree',
      orderBy: 'created_at',
      columns: {id: {type: 'nanoid'}, created_at: {type: 'datetime'}}
    })

    const summary = await Migration.migrate()

    expect(summary.default.schema).toEqual([expect.objectContaining({type: 'remove_ttl', table: 'events'})])
    expect(conn.execs).toContain('ALTER TABLE `events` REMOVE TTL')
    expect(conn.inserts).toEqual([
      {table: '_odac_migrations', rows: [{name: 'events', connection: 'default', type: 'ttl', batch: 4, value: ''}]}
    ])
  })

  it('dry-run reports a pending TTL change without executing ALTER', async () => {
    const conn = makeFakeAdapter(['_odac_migrations', 'events'])
    conn._columnInfo['_odac_migrations'] = {name: {}, connection: {}, type: {}, batch: {}, value: {}, applied_at: {}}
    conn._columnInfo['events'] = {id: {type: 'String'}, created_at: {type: 'DateTime'}}
    conn._queryHandler = () => []
    Migration.init(tmpDir, {default: conn})
    writeSchema('events', {
      engine: 'MergeTree',
      orderBy: 'created_at',
      ttl: 'created_at + INTERVAL 90 DAY',
      columns: {id: {type: 'nanoid'}, created_at: {type: 'datetime'}}
    })

    const summary = await Migration.status()

    expect(summary.default.schema).toEqual([
      expect.objectContaining({type: 'modify_ttl', table: 'events', ttl: 'created_at + INTERVAL 90 DAY'})
    ])
    expect(conn.execs).toEqual([])
    expect(conn.inserts).toEqual([])
  })

  it('syncs TTL independently across multiple ClickHouse connections', async () => {
    // Two named connections, same table name on both. `analytics` drifted (7 DAY recorded),
    // `metrics` is already in sync — only `analytics` must receive a MODIFY TTL.
    const analytics = makeFakeAdapter(['_odac_migrations', 'events'])
    const metrics = makeFakeAdapter(['_odac_migrations', 'events'])
    for (const conn of [analytics, metrics]) {
      conn._columnInfo['_odac_migrations'] = {name: {}, connection: {}, type: {}, batch: {}, value: {}, applied_at: {}}
      conn._columnInfo['events'] = {id: {type: 'String'}, created_at: {type: 'DateTime'}}
    }
    analytics._queryHandler = sql => (sql.includes("type = 'ttl'") ? [{value: 'created_at + INTERVAL 7 DAY', batch: 1}] : [])
    metrics._queryHandler = sql => (sql.includes("type = 'ttl'") ? [{value: 'created_at + INTERVAL 30 DAY', batch: 1}] : [])

    const schema = {
      engine: 'MergeTree',
      orderBy: 'created_at',
      ttl: 'created_at + INTERVAL 30 DAY',
      columns: {id: {type: 'nanoid'}, created_at: {type: 'datetime'}}
    }
    writeSchema('events', schema, 'analytics')
    writeSchema('events', schema, 'metrics')
    Migration.init(tmpDir, {analytics, metrics})

    const summary = await Migration.migrate()

    expect(summary.analytics.schema).toEqual([
      expect.objectContaining({type: 'modify_ttl', table: 'events', ttl: 'created_at + INTERVAL 30 DAY'})
    ])
    expect(summary.metrics.schema).toEqual([])
    expect(analytics.execs).toContain('ALTER TABLE `events` MODIFY TTL created_at + INTERVAL 30 DAY')
    expect(metrics.execs.some(s => s.includes('MODIFY TTL') || s.includes('REMOVE TTL'))).toBe(false)

    // Revision rows are scoped by connection key, and the lookup filters on it too.
    expect(analytics.inserts).toEqual([
      {
        table: '_odac_migrations',
        rows: [{name: 'events', connection: 'analytics', type: 'ttl', batch: 2, value: 'created_at + INTERVAL 30 DAY'}]
      }
    ])
    expect(metrics.inserts).toEqual([])
    expect(analytics.query.mock.calls.some(([sql]) => sql.includes("connection = 'analytics'"))).toBe(true)
    expect(metrics.query.mock.calls.some(([sql]) => sql.includes("connection = 'metrics'"))).toBe(true)
  })

  it('ignores the ttl field for non-MergeTree engines', async () => {
    const conn = makeFakeAdapter(['_odac_migrations', 'mem'])
    conn._columnInfo['_odac_migrations'] = {name: {}, connection: {}, type: {}, batch: {}, value: {}, applied_at: {}}
    conn._columnInfo['mem'] = {a: {type: 'Int32'}}
    Migration.init(tmpDir, {default: conn})
    writeSchema('mem', {engine: 'Memory', ttl: 'created_at + INTERVAL 1 DAY', columns: {a: {type: 'integer'}}})

    const summary = await Migration.migrate()

    expect(summary.default.schema).toEqual([])
    expect(conn.execs.some(s => s.includes('TTL'))).toBe(false)
  })

  it('rejects rollback on a ClickHouse connection', async () => {
    const conn = makeFakeAdapter([])
    Migration.init(tmpDir, {default: conn})
    await expect(Migration.rollback()).rejects.toThrow(/not supported on ClickHouse/)
  })

  it('rejects snapshot on a ClickHouse connection', async () => {
    const conn = makeFakeAdapter([])
    Migration.init(tmpDir, {default: conn})
    await expect(Migration.snapshot()).rejects.toThrow(/not supported on ClickHouse/)
  })
})
