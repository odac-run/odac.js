'use strict'

const {resolveClient, buildConnections} = require('../../../src/Database/ConnectionFactory')
const ClickHouseAdapter = require('../../../src/Database/ClickHouseAdapter')

describe('ConnectionFactory ClickHouse routing', () => {
  it('resolves clickhouse aliases to the clickhouse sentinel', () => {
    expect(resolveClient('clickhouse')).toBe('clickhouse')
    expect(resolveClient('ch')).toBe('clickhouse')
  })

  it('builds a ClickHouseAdapter for a clickhouse connection (no Knex, lazy connect)', () => {
    const connections = buildConnections({
      analytics: {type: 'clickhouse', host: 'ch.local', port: 8123, database: 'metrics'}
    })
    expect(connections.analytics).toBeInstanceOf(ClickHouseAdapter)
    expect(connections.analytics._odacDialect).toBe('clickhouse')
    expect(connections.analytics._odacConnectionKey).toBe('analytics')
  })

  it('supports mixing clickhouse with SQL connections', () => {
    const connections = buildConnections({
      default: {type: 'sqlite', filename: ':memory:'},
      analytics: {type: 'clickhouse', host: 'ch.local'}
    })
    expect(connections.analytics).toBeInstanceOf(ClickHouseAdapter)
    expect(connections.default._odacDialect).toBeUndefined()
    // SQL connection is a real Knex instance
    expect(typeof connections.default.raw).toBe('function')
  })
})
