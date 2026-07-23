'use strict'

const ch = require('../../../src/Database/ClickHouse')

// A representative metrics schema mirroring the app_stat downsampling use case:
// >24h → 10-minute buckets, >30d → daily buckets, >2y → purge.
const baseRollupSchema = () => ({
  engine: 'MergeTree',
  partitionBy: 'toYYYYMM(t)',
  rollup: {
    time: 't',
    by: ['resource_id'],
    tiers: [
      {olderThan: '24 HOUR', bucket: 'tenMinutes'},
      {olderThan: '30 DAY', bucket: 'day'},
      {olderThan: '2 YEAR', delete: true}
    ],
    set: {cpu: 'sum', mem_used: 'sum', mem_percent: 'sum', net_rx_total: 'max', pids: 'max'}
  },
  columns: {
    resource_id: {type: 'string'},
    server_id: {type: 'string'},
    t: {type: 'specificType', length: 'DateTime64(3)'},
    cpu: {type: 'specificType', length: 'Float32'},
    mem_used: {type: 'specificType', length: 'UInt64'},
    mem_percent: {type: 'specificType', length: 'Float32'},
    net_rx_total: {type: 'specificType', length: 'UInt64'},
    pids: {type: 'specificType', length: 'UInt32'}
  }
})

describe('ClickHouse.compileRollup() — happy path', () => {
  it('derives ORDER BY as [by, buckets coarse→fine] with raw bucket expressions', () => {
    const out = ch.compileRollup(baseRollupSchema())
    expect(out.orderBy).toEqual(['resource_id', 'toStartOfDay(t)', 'toStartOfTenMinutes(t)'])
  })

  it('emits one TTL tier per rollup level, each GROUP BY an ORDER BY prefix', () => {
    const {ttl} = ch.compileRollup(baseRollupSchema())
    // Finest tier (24h) groups by the full bucket chain; coarser tier (30d) by the day prefix only.
    expect(ttl).toContain('t + INTERVAL 24 HOUR GROUP BY resource_id, toStartOfDay(t), toStartOfTenMinutes(t) SET ')
    expect(ttl).toContain('t + INTERVAL 30 DAY GROUP BY resource_id, toStartOfDay(t) SET ')
  })

  it('sums the injected samples column in every rollup SET', () => {
    const {ttl} = ch.compileRollup(baseRollupSchema())
    const sets = ttl.match(/samples = sum\(samples\)/g) || []
    expect(sets).toHaveLength(2) // one per non-delete tier
    expect(ttl).toContain('cpu = sum(cpu)')
    expect(ttl).toContain('net_rx_total = max(net_rx_total)')
  })

  it('appends the DELETE tier last with no GROUP BY/SET', () => {
    const {ttl} = ch.compileRollup(baseRollupSchema())
    expect(ttl.endsWith('t + INTERVAL 2 YEAR DELETE')).toBe(true)
  })

  it('injects a samples UInt64 DEFAULT 1 column and strips the rollup key', () => {
    const out = ch.compileRollup(baseRollupSchema())
    expect(out.columns.samples).toEqual({type: 'specificType', length: 'UInt64', default: 1})
    expect(out.rollup).toBeUndefined()
  })

  it('is idempotent — a compiled schema passes through unchanged', () => {
    const once = ch.compileRollup(baseRollupSchema())
    const twice = ch.compileRollup(once)
    expect(twice.ttl).toBe(once.ttl)
    expect(twice.orderBy).toEqual(once.orderBy)
  })

  it('returns non-rollup schemas untouched', () => {
    const schema = {engine: 'MergeTree', orderBy: 'id', columns: {id: {type: 'integer'}}}
    expect(ch.compileRollup(schema)).toBe(schema)
  })

  it('produces a deterministic single-line TTL (stable for the migration TTL-diff)', () => {
    const a = ch.compileRollup(baseRollupSchema()).ttl
    const b = ch.compileRollup(baseRollupSchema()).ttl
    expect(a).toBe(b)
    expect(a).not.toContain('\n')
  })

  it('honors count/samplesColumn overrides for the sample column name', () => {
    const s1 = baseRollupSchema()
    s1.rollup.count = 'n'
    expect(ch.compileRollup(s1).columns.n).toBeDefined()
    expect(ch.compileRollup(s1).ttl).toContain('n = sum(n)')

    const s2 = baseRollupSchema()
    s2.rollup.samplesColumn = 'hits'
    expect(ch.compileRollup(s2).columns.hits).toBeDefined()
  })
})

describe('ClickHouse.compileRollup() — orderBy reconciliation', () => {
  it('accepts a hand-written orderBy that starts with the derived prefix', () => {
    const s = baseRollupSchema()
    s.orderBy = ['resource_id', 'toStartOfDay(t)', 'toStartOfTenMinutes(t)']
    expect(() => ch.compileRollup(s)).not.toThrow()
    expect(ch.compileRollup(s).orderBy).toEqual(s.orderBy)
  })

  it('tolerates whitespace differences when matching the prefix', () => {
    const s = baseRollupSchema()
    s.orderBy = ['resource_id', 'toStartOfDay( t )', 'toStartOfTenMinutes(t)', 'server_id']
    expect(() => ch.compileRollup(s)).not.toThrow()
  })

  it('throws (never silently ignores) when orderBy does not start with the derived prefix', () => {
    const s = baseRollupSchema()
    s.orderBy = ['toStartOfDay(t)', 'resource_id'] // wrong leading order
    expect(() => ch.compileRollup(s)).toThrow(/must start with the derived rollup key prefix/)
  })
})

describe('ClickHouse.compileRollup() — reserve buckets', () => {
  // Adds a coarse ('week') and a fine ('minute') reserve to the base ladder (tenMinutes → day).
  const withReserves = () => {
    const s = baseRollupSchema()
    s.rollup.tiers = [
      {bucket: 'minute', reserve: true},
      {olderThan: '24 HOUR', bucket: 'tenMinutes'},
      {olderThan: '30 DAY', bucket: 'day'},
      {bucket: 'week', reserve: true},
      {olderThan: '2 YEAR', delete: true}
    ]
    return s
  }

  it('adds reserved buckets to ORDER BY, coarse→fine, without emitting a TTL step for them', () => {
    const out = ch.compileRollup(withReserves())
    expect(out.orderBy).toEqual(['resource_id', 'toStartOfWeek(t)', 'toStartOfDay(t)', 'toStartOfTenMinutes(t)', 'toStartOfMinute(t)'])
    // Reserves shape ORDER BY but never appear as their own INTERVAL step.
    expect(out.ttl).toContain('t + INTERVAL 24 HOUR')
    expect(out.ttl).toContain('t + INTERVAL 30 DAY')
  })

  it('does not create a rollup or delete step for a reserved bucket', () => {
    const {ttl} = ch.compileRollup(withReserves())
    // Two real rollup tiers + one delete → exactly two GROUP BY clauses, one DELETE.
    expect((ttl.match(/GROUP BY/g) || []).length).toBe(2)
    expect((ttl.match(/DELETE/g) || []).length).toBe(1)
  })

  it('rides a coarser reserve (week) along in each GROUP BY, but keeps a finer reserve (minute) out', () => {
    const {ttl} = ch.compileRollup(withReserves())
    // Coarser 'week' precedes every active bucket in GROUP BY; finer 'minute' never appears.
    expect(ttl).toContain('GROUP BY resource_id, toStartOfWeek(t), toStartOfDay(t), toStartOfTenMinutes(t) SET')
    expect(ttl).toContain('GROUP BY resource_id, toStartOfWeek(t), toStartOfDay(t) SET')
    expect(ttl).not.toContain('toStartOfMinute(t) SET')
    expect(ttl).not.toContain('toStartOfMinute')
  })

  it('activating a reserved bucket keeps the SAME ORDER BY (no recreate) — only the TTL grows', () => {
    const reserved = ch.compileRollup(withReserves())

    const activated = withReserves()
    // Swap the 'week' reserve for a real tier between day (30d) and delete (2y).
    activated.rollup.tiers = [
      {bucket: 'minute', reserve: true},
      {olderThan: '24 HOUR', bucket: 'tenMinutes'},
      {olderThan: '30 DAY', bucket: 'day'},
      {olderThan: '60 DAY', bucket: 'week'},
      {olderThan: '2 YEAR', delete: true}
    ]
    const out = ch.compileRollup(activated)

    expect(out.orderBy).toEqual(reserved.orderBy) // identical sorting key → migration = MODIFY TTL only
    expect(out.ttl).toContain('t + INTERVAL 60 DAY GROUP BY resource_id, toStartOfWeek(t) SET')
  })

  it('throws when a reserve tier carries olderThan', () => {
    const s = baseRollupSchema()
    s.rollup.tiers.push({olderThan: '90 DAY', bucket: 'week', reserve: true})
    expect(() => ch.compileRollup(s)).toThrow(/reserve tier .* must not have 'olderThan'/)
  })

  it('throws when a tier omits olderThan without reserve/delete (forgotten-olderThan footgun)', () => {
    const s = baseRollupSchema()
    s.rollup.tiers[0] = {bucket: 'tenMinutes'} // dropped olderThan by mistake
    expect(() => ch.compileRollup(s)).toThrow(/needs an 'olderThan'/)
  })

  it('rejects reserving a bucket already used by a rollup tier', () => {
    const s = baseRollupSchema()
    s.rollup.tiers.push({bucket: 'day', reserve: true}) // 'day' is already an active tier
    expect(() => ch.compileRollup(s)).toThrow(/already used by a rollup tier/)
  })

  it('rejects an invalid reserve bucket name', () => {
    const s = baseRollupSchema()
    s.rollup.tiers.push({bucket: 'fortnight', reserve: true})
    expect(() => ch.compileRollup(s)).toThrow(/reserve tier .* invalid bucket 'fortnight'/)
  })
})

describe('ClickHouse.compileRollup() — validation', () => {
  it('rejects avg with a sum+samples hint', () => {
    const s = baseRollupSchema()
    s.rollup.set.cpu = 'avg'
    expect(() => ch.compileRollup(s)).toThrow(/avg.*divide by 'samples' at read time/s)
  })

  it('rejects unknown aggregate functions', () => {
    const s = baseRollupSchema()
    s.rollup.set.cpu = 'median'
    expect(() => ch.compileRollup(s)).toThrow(/unsupported aggregate 'median'/)
  })

  it('rejects unknown bucket names', () => {
    const s = baseRollupSchema()
    s.rollup.tiers[0].bucket = 'threeMinutes'
    expect(() => ch.compileRollup(s)).toThrow(/invalid bucket 'threeMinutes'/)
  })

  it('rejects malformed olderThan intervals', () => {
    const s = baseRollupSchema()
    s.rollup.tiers[0].olderThan = 'soon'
    expect(() => ch.compileRollup(s)).toThrow(/invalid 'olderThan' interval/)
  })

  it('rejects buckets that get finer as data ages', () => {
    const s = baseRollupSchema()
    s.rollup.tiers = [
      {olderThan: '24 HOUR', bucket: 'day'},
      {olderThan: '30 DAY', bucket: 'tenMinutes'}
    ]
    expect(() => ch.compileRollup(s)).toThrow(/coarser \(or equal\) as data ages/)
  })

  it('requires the delete tier to be the oldest', () => {
    const s = baseRollupSchema()
    s.rollup.tiers = [
      {olderThan: '30 DAY', delete: true},
      {olderThan: '24 HOUR', bucket: 'tenMinutes'}
    ]
    // sorted by age: 24h rollup then 30d delete → delete IS last, so this must PASS
    expect(() => ch.compileRollup(s)).not.toThrow()

    s.rollup.tiers = [
      {olderThan: '30 DAY', delete: true},
      {olderThan: '2 YEAR', bucket: 'day'}
    ]
    // delete at 30d but a rollup at 2y is older → delete is not last → must THROW
    expect(() => ch.compileRollup(s)).toThrow(/delete tier must have the largest/)
  })

  it('rejects a time column that is not declared', () => {
    const s = baseRollupSchema()
    s.rollup.time = 'nope'
    expect(() => ch.compileRollup(s)).toThrow(/'time' column 'nope' is not declared/)
  })

  it('rejects a set column that overlaps a by dimension', () => {
    const s = baseRollupSchema()
    s.rollup.set.resource_id = 'any'
    expect(() => ch.compileRollup(s)).toThrow(/must not include a 'by' dimension/)
  })

  it('rejects rollup on a non-MergeTree engine', () => {
    const s = baseRollupSchema()
    s.engine = 'Memory'
    expect(() => ch.compileRollup(s)).toThrow(/requires a MergeTree-family engine/)
  })
})

describe('ClickHouse.buildCreateTableDDL() — rollup integration', () => {
  it('renders a full CREATE TABLE from a rollup schema', () => {
    const ddl = ch.buildCreateTableDDL('app_stat', baseRollupSchema())
    expect(ddl).toContain('ORDER BY (`resource_id`, toStartOfDay(t), toStartOfTenMinutes(t))')
    expect(ddl).toContain('TTL t + INTERVAL 24 HOUR GROUP BY resource_id, toStartOfDay(t), toStartOfTenMinutes(t) SET ')
    expect(ddl).toContain('`samples` UInt64 DEFAULT 1')
    expect(ddl).toContain('PARTITION BY toYYYYMM(t)')
    // Clause order: PARTITION BY → ORDER BY → TTL
    expect(ddl.indexOf('PARTITION BY')).toBeLessThan(ddl.indexOf('ORDER BY'))
    expect(ddl.indexOf('ORDER BY')).toBeLessThan(ddl.indexOf('TTL t + INTERVAL'))
  })
})
