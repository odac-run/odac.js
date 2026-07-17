'use strict'

const ClickHouseQuery = require('../../../src/Database/ClickHouseQuery')

function makeAdapter(rows = []) {
  return {
    query: jest.fn(async () => rows),
    _odacConnectionKey: 'analytics'
  }
}

describe('ClickHouseQuery.toSQL()', () => {
  it('defaults to SELECT * FROM table', () => {
    const q = new ClickHouseQuery(makeAdapter(), 'events')
    expect(q.toSQL()).toBe('SELECT * FROM `events`')
  })

  it('selects explicit columns/expressions verbatim', () => {
    const q = new ClickHouseQuery(makeAdapter(), 'events').select('path', 'count() AS c')
    expect(q.toSQL()).toBe('SELECT path, count() AS c FROM `events`')
  })

  it('builds equality where from an object', () => {
    const q = new ClickHouseQuery(makeAdapter(), 'events').where({user_id: 42, event: 'login'})
    expect(q.toSQL()).toBe("SELECT * FROM `events` WHERE `user_id` = 42 AND `event` = 'login'")
  })

  it('supports operator where and escapes string literals', () => {
    const q = new ClickHouseQuery(makeAdapter(), 'events').where('created_at', '>=', '2026-01-01').where('name', "O'Brien")
    expect(q.toSQL()).toBe("SELECT * FROM `events` WHERE `created_at` >= '2026-01-01' AND `name` = 'O''Brien'")
  })

  it('renders IS NULL / IS NOT NULL', () => {
    const eq = new ClickHouseQuery(makeAdapter(), 't').where('source', null)
    expect(eq.toSQL()).toBe('SELECT * FROM `t` WHERE `source` IS NULL')
    const ne = new ClickHouseQuery(makeAdapter(), 't').where('source', '!=', null)
    expect(ne.toSQL()).toBe('SELECT * FROM `t` WHERE `source` IS NOT NULL')
  })

  it('builds whereIn and guards empty arrays', () => {
    const q = new ClickHouseQuery(makeAdapter(), 't').whereIn('id', [1, 2, 3])
    expect(q.toSQL()).toBe('SELECT * FROM `t` WHERE `id` IN (1, 2, 3)')
    const empty = new ClickHouseQuery(makeAdapter(), 't').whereIn('id', [])
    expect(empty.toSQL()).toBe('SELECT * FROM `t` WHERE 1 = 0')
  })

  it('composes groupBy, orderBy, limit and offset', () => {
    const q = new ClickHouseQuery(makeAdapter(), 'events')
      .select('path', 'count() AS c')
      .groupBy('path')
      .orderBy('c', 'desc')
      .limit(10)
      .offset(20)
    expect(q.toSQL()).toBe('SELECT path, count() AS c FROM `events` GROUP BY `path` ORDER BY `c` DESC LIMIT 20, 10')
  })
})

describe('ClickHouseQuery execution', () => {
  it('is thenable — awaiting runs the compiled query', async () => {
    const adapter = makeAdapter([{a: 1}])
    const rows = await new ClickHouseQuery(adapter, 'events').where('a', 1)
    expect(rows).toEqual([{a: 1}])
    expect(adapter.query).toHaveBeenCalledWith('SELECT * FROM `events` WHERE `a` = 1')
  })

  it('first() adds LIMIT 1 and returns a single row or null', async () => {
    const withRow = makeAdapter([{id: 5}])
    expect(await new ClickHouseQuery(withRow, 'events').first()).toEqual({id: 5})
    expect(withRow.query).toHaveBeenCalledWith('SELECT * FROM `events` LIMIT 1')

    const empty = makeAdapter([])
    expect(await new ClickHouseQuery(empty, 'events').first()).toBeNull()
  })

  it('count() compiles count() and returns a plain number', async () => {
    const adapter = makeAdapter([{count: '17'}])
    const n = await new ClickHouseQuery(adapter, 'events').where('event', 'login').count()
    expect(n).toBe(17)
    expect(adapter.query).toHaveBeenCalledWith("SELECT count() AS count FROM `events` WHERE `event` = 'login'")
  })
})
