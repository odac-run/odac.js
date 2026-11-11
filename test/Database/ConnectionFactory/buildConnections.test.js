const mockKnex = jest.fn()
jest.mock(
  'knex',
  () =>
    (...args) =>
      mockKnex(...args)
)

jest.mock('mysql2', () => ({}), {virtual: true})
jest.mock('pg', () => ({}), {virtual: true})
jest.mock('sqlite3', () => ({}), {virtual: true})

const {buildConnections} = require('../../../src/Database/ConnectionFactory')

describe('ConnectionFactory.buildConnections()', () => {
  beforeEach(() => {
    mockKnex.mockReset()
    mockKnex.mockImplementation(options => ({options, raw: jest.fn()}))
  })

  it('should support single database config', () => {
    const connections = buildConnections({type: 'mysql', user: 'root', database: 'app'})
    expect(Object.keys(connections)).toEqual(['default'])
    expect(mockKnex).toHaveBeenCalledTimes(1)
  })

  it('should support multi database config', () => {
    const connections = buildConnections({
      analytics: {type: 'postgres', user: 'u', database: 'a'},
      default: {type: 'sqlite', filename: './dev.sqlite3'}
    })
    expect(Object.keys(connections).sort()).toEqual(['analytics', 'default'])
    expect(mockKnex).toHaveBeenCalledTimes(2)
  })

  // Every process (primary + one worker per core) opens its own pool. A fixed
  // 10 per process made 330 connections on 32 cores, over PostgreSQL's default
  // max_connections of 100, so workers failed to connect under load.
  describe('pool size', () => {
    const poolMax = () => mockKnex.mock.calls.at(-1)[0].pool.max

    it('keeps 10 for a single process such as the migration CLI', () => {
      buildConnections({type: 'postgres', database: 'app'})
      expect(poolMax()).toBe(10)
    })

    it('splits the default budget across the cluster', () => {
      buildConnections({type: 'postgres', database: 'app'}, {processCount: 33})
      expect(poolMax() * 33).toBeLessThanOrEqual(100)
    })

    it('never goes below 2, so a transaction cannot starve its own process', () => {
      buildConnections({type: 'postgres', database: 'app'}, {processCount: 200})
      expect(poolMax()).toBe(2)
    })

    it('uses an explicit connectionLimit as the per-process size', () => {
      buildConnections({type: 'postgres', database: 'app', connectionLimit: 25}, {processCount: 33})
      expect(poolMax()).toBe(25)
    })
  })
})
