'use strict'

const ch = require('../../../src/Database/ClickHouse')

describe('ClickHouse.mapColumnType()', () => {
  it('maps common ODAC types to ClickHouse types', () => {
    expect(ch.mapColumnType({type: 'integer'})).toBe('Int32')
    expect(ch.mapColumnType({type: 'integer', unsigned: true})).toBe('UInt32')
    expect(ch.mapColumnType({type: 'bigInteger'})).toBe('Int64')
    expect(ch.mapColumnType({type: 'float'})).toBe('Float64')
    expect(ch.mapColumnType({type: 'decimal', precision: 12, scale: 4})).toBe('Decimal(12, 4)')
    expect(ch.mapColumnType({type: 'boolean'})).toBe('UInt8')
    expect(ch.mapColumnType({type: 'string', length: 255})).toBe('String')
    expect(ch.mapColumnType({type: 'nanoid'})).toBe('String')
    expect(ch.mapColumnType({type: 'text'})).toBe('String')
    expect(ch.mapColumnType({type: 'date'})).toBe('Date')
    expect(ch.mapColumnType({type: 'datetime'})).toBe('DateTime')
    expect(ch.mapColumnType({type: 'timestamp'})).toBe('DateTime')
    expect(ch.mapColumnType({type: 'uuid'})).toBe('UUID')
    expect(ch.mapColumnType({type: 'json'})).toBe('String')
  })

  it('wraps in Nullable only when nullable is explicitly true', () => {
    expect(ch.mapColumnType({type: 'string', nullable: true})).toBe('Nullable(String)')
    expect(ch.mapColumnType({type: 'integer', nullable: true})).toBe('Nullable(Int32)')
    // Unspecified nullable → NOT NULL (ClickHouse native default), unlike SQL engines
    expect(ch.mapColumnType({type: 'string'})).toBe('String')
    expect(ch.mapColumnType({type: 'string', nullable: false})).toBe('String')
  })

  it('passes specificType through verbatim without Nullable wrapping', () => {
    expect(ch.mapColumnType({type: 'specificType', length: 'LowCardinality(String)'})).toBe('LowCardinality(String)')
    expect(ch.mapColumnType({type: 'specificType', length: 'Array(UInt32)', nullable: true})).toBe('Array(UInt32)')
  })

  it('builds Enum8 from enum values', () => {
    expect(ch.mapColumnType({type: 'enum', values: ['a', 'b']})).toBe("Enum8('a' = 1, 'b' = 2)")
  })

  it('passes unknown native type names through', () => {
    expect(ch.mapColumnType({type: 'IPv4'})).toBe('IPv4')
  })
})

describe('ClickHouse.quoteIdent() / quoteLiteral()', () => {
  it('backtick-quotes identifiers and escapes backticks', () => {
    expect(ch.quoteIdent('events')).toBe('`events`')
    expect(ch.quoteIdent('we`ird')).toBe('`we``ird`')
  })

  it('single-quotes literals and escapes quotes/backslashes', () => {
    expect(ch.quoteLiteral("O'Brien")).toBe("'O''Brien'")
    expect(ch.quoteLiteral('a\\b')).toBe("'a\\\\b'")
  })
})

describe('ClickHouse.buildCreateTableDDL()', () => {
  it('builds a MergeTree table with engine and ORDER BY', () => {
    const ddl = ch.buildCreateTableDDL('events', {
      engine: 'MergeTree',
      orderBy: ['created_at', 'id'],
      columns: {
        id: {type: 'nanoid'},
        event: {type: 'string'},
        count: {type: 'integer'},
        created_at: {type: 'datetime'}
      }
    })

    expect(ddl).toContain('CREATE TABLE IF NOT EXISTS `events` (')
    expect(ddl).toContain('`id` String')
    expect(ddl).toContain('`count` Int32')
    expect(ddl).toContain('ENGINE = MergeTree()')
    expect(ddl).toContain('ORDER BY (`created_at`, `id`)')
  })

  it('defaults ORDER BY to tuple() when omitted for MergeTree family', () => {
    const ddl = ch.buildCreateTableDDL('logs', {columns: {msg: {type: 'string'}}})
    expect(ddl).toContain('ENGINE = MergeTree()')
    expect(ddl).toContain('ORDER BY tuple()')
  })

  it('includes PARTITION BY and SETTINGS when provided', () => {
    const ddl = ch.buildCreateTableDDL('events', {
      engine: 'MergeTree',
      orderBy: 'id',
      partitionBy: 'toYYYYMM(created_at)',
      settings: 'index_granularity = 8192',
      columns: {id: {type: 'integer'}, created_at: {type: 'datetime'}}
    })
    expect(ddl).toContain('PARTITION BY toYYYYMM(created_at)')
    expect(ddl).toContain('SETTINGS index_granularity = 8192')
    // Clause order: ENGINE → PARTITION BY → ORDER BY → SETTINGS
    expect(ddl.indexOf('PARTITION BY')).toBeLessThan(ddl.indexOf('ORDER BY'))
    expect(ddl.indexOf('ORDER BY')).toBeLessThan(ddl.indexOf('SETTINGS'))
  })

  it('passes parameterized engines through verbatim', () => {
    const ddl = ch.buildCreateTableDDL('t', {
      engine: 'ReplacingMergeTree(ver)',
      orderBy: 'id',
      columns: {id: {type: 'integer'}, ver: {type: 'integer'}}
    })
    expect(ddl).toContain('ENGINE = ReplacingMergeTree(ver)')
  })

  it('omits ORDER BY for non-MergeTree engines', () => {
    const ddl = ch.buildCreateTableDDL('m', {engine: 'Memory', columns: {a: {type: 'integer'}}})
    expect(ddl).toContain('ENGINE = Memory()')
    expect(ddl).not.toContain('ORDER BY')
  })

  it('expands the virtual timestamps type into created_at/updated_at', () => {
    const ddl = ch.buildCreateTableDDL('t', {orderBy: 'id', columns: {id: {type: 'integer'}, ts: {type: 'timestamps'}}})
    expect(ddl).toContain('`created_at` DateTime DEFAULT now()')
    expect(ddl).toContain('`updated_at` DateTime DEFAULT now()')
  })

  it('renders DEFAULT clauses for scalars and now()', () => {
    const ddl = ch.buildCreateTableDDL('t', {
      orderBy: 'id',
      columns: {
        id: {type: 'integer'},
        status: {type: 'string', default: 'active'},
        score: {type: 'integer', default: 0},
        seen_at: {type: 'datetime', default: 'now()'}
      }
    })
    expect(ddl).toContain("`status` String DEFAULT 'active'")
    expect(ddl).toContain('`score` Int32 DEFAULT 0')
    expect(ddl).toContain('`seen_at` DateTime DEFAULT now()')
  })

  it('emits table-level TTL between ORDER BY and SETTINGS for MergeTree', () => {
    const ddl = ch.buildCreateTableDDL('events', {
      engine: 'MergeTree',
      orderBy: 'created_at',
      partitionBy: 'toYYYYMM(created_at)',
      ttl: 'created_at + INTERVAL 30 DAY',
      settings: 'index_granularity = 8192',
      columns: {id: {type: 'integer'}, created_at: {type: 'datetime'}}
    })
    expect(ddl).toContain('TTL created_at + INTERVAL 30 DAY')
    // Clause order: ORDER BY → TTL → SETTINGS
    expect(ddl.indexOf('ORDER BY')).toBeLessThan(ddl.indexOf('TTL created_at'))
    expect(ddl.indexOf('TTL created_at')).toBeLessThan(ddl.indexOf('SETTINGS'))
  })

  it('passes a TTL expression with a DELETE/GROUP BY tail through verbatim', () => {
    const ddl = ch.buildCreateTableDDL('events', {
      orderBy: 'created_at',
      ttl: 'created_at + INTERVAL 7 DAY DELETE WHERE status = 2',
      columns: {status: {type: 'integer'}, created_at: {type: 'datetime'}}
    })
    expect(ddl).toContain('TTL created_at + INTERVAL 7 DAY DELETE WHERE status = 2')
  })

  it('omits table-level TTL for non-MergeTree engines', () => {
    const ddl = ch.buildCreateTableDDL('m', {
      engine: 'Memory',
      ttl: 'created_at + INTERVAL 1 DAY',
      columns: {created_at: {type: 'datetime'}}
    })
    expect(ddl).not.toContain('TTL')
  })

  it('emits column-level TTL after the DEFAULT clause', () => {
    const ddl = ch.buildCreateTableDDL('events', {
      orderBy: 'created_at',
      columns: {
        created_at: {type: 'datetime'},
        secret: {type: 'string', default: '', ttl: 'created_at + INTERVAL 7 DAY'}
      }
    })
    expect(ddl).toContain("`secret` String DEFAULT '' TTL created_at + INTERVAL 7 DAY")
  })

  it('throws when a table has no columns', () => {
    expect(() => ch.buildCreateTableDDL('empty', {columns: {}})).toThrow(/no columns/)
  })
})

describe('ClickHouse.ttlColumnClause() / ttlTableClause()', () => {
  it('renders a column TTL fragment or empty string', () => {
    expect(ch.ttlColumnClause({ttl: 'created_at + INTERVAL 1 DAY'})).toBe(' TTL created_at + INTERVAL 1 DAY')
    expect(ch.ttlColumnClause({ttl: '  ts + INTERVAL 1 HOUR  '})).toBe(' TTL ts + INTERVAL 1 HOUR')
    expect(ch.ttlColumnClause({})).toBe('')
    expect(ch.ttlColumnClause({ttl: ''})).toBe('')
    expect(ch.ttlColumnClause({ttl: '   '})).toBe('')
  })

  it('renders a table TTL only for MergeTree-family engines', () => {
    expect(ch.ttlTableClause('created_at + INTERVAL 1 DAY', 'MergeTree()')).toBe('TTL created_at + INTERVAL 1 DAY')
    expect(ch.ttlTableClause('created_at + INTERVAL 1 DAY', 'ReplacingMergeTree(ver)')).toBe('TTL created_at + INTERVAL 1 DAY')
    expect(ch.ttlTableClause('created_at + INTERVAL 1 DAY', 'Memory()')).toBe('')
    expect(ch.ttlTableClause('', 'MergeTree()')).toBe('')
    expect(ch.ttlTableClause(undefined, 'MergeTree()')).toBe('')
  })
})

describe('ClickHouse.buildAddColumnDDL()', () => {
  it('builds an idempotent ADD COLUMN statement', () => {
    const ddl = ch.buildAddColumnDDL('events', 'source', {type: 'string', nullable: true})
    expect(ddl).toBe('ALTER TABLE `events` ADD COLUMN IF NOT EXISTS `source` Nullable(String)')
  })

  it('carries a column-level TTL into ADD COLUMN', () => {
    const ddl = ch.buildAddColumnDDL('events', 'token', {type: 'string', ttl: 'created_at + INTERVAL 3 DAY'})
    expect(ddl).toBe('ALTER TABLE `events` ADD COLUMN IF NOT EXISTS `token` String TTL created_at + INTERVAL 3 DAY')
  })
})
