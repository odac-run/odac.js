'use strict'

// Mock the @clickhouse/client module (not installed as a dependency in this repo).
const mockQuery = jest.fn()
const mockCommand = jest.fn()
const mockInsert = jest.fn()
const mockClose = jest.fn()
const mockCreateClient = jest.fn(() => ({
  query: mockQuery,
  command: mockCommand,
  insert: mockInsert,
  close: mockClose
}))

jest.mock('@clickhouse/client', () => ({createClient: mockCreateClient}), {virtual: true})

const ClickHouseAdapter = require('../../../src/Database/ClickHouseAdapter')

describe('ClickHouseAdapter', () => {
  beforeEach(() => {
    mockQuery.mockReset()
    mockCommand.mockReset()
    mockInsert.mockReset()
    mockClose.mockReset()
    mockCreateClient.mockClear()
  })

  it('carries the clickhouse dialect markers', () => {
    const a = new ClickHouseAdapter({}, 'analytics')
    expect(a._odacDialect).toBe('clickhouse')
    expect(a._odacConnectionKey).toBe('analytics')
    expect(a.client.config.client).toBe('clickhouse')
  })

  it('does not open a client on construction (lazy connect)', () => {
    new ClickHouseAdapter({host: 'x'}, 'k')
    expect(mockCreateClient).not.toHaveBeenCalled()
  })

  it('assembles a url from host/port when no url given', async () => {
    const a = new ClickHouseAdapter({host: 'db.local', port: 9000, user: 'u', password: 'p', database: 'metrics'}, 'k')
    mockQuery.mockResolvedValue({json: async () => []})
    await a.query('SELECT 1')
    expect(mockCreateClient).toHaveBeenCalledWith(
      expect.objectContaining({url: 'http://db.local:9000', username: 'u', password: 'p', database: 'metrics'})
    )
  })

  it('routes reads through query() and commands through exec()', async () => {
    const a = new ClickHouseAdapter({}, 'k')
    mockQuery.mockResolvedValue({json: async () => [{one: 1}]})

    await a.raw('SELECT 1')
    expect(mockQuery).toHaveBeenCalledWith({query: 'SELECT 1', format: 'JSONEachRow'})

    await a.raw('CREATE TABLE t (a Int32) ENGINE = Memory()')
    expect(mockCommand).toHaveBeenCalledWith({query: 'CREATE TABLE t (a Int32) ENGINE = Memory()'})
  })

  it('treats SHOW / DESCRIBE / EXISTS / WITH as reads', async () => {
    const a = new ClickHouseAdapter({}, 'k')
    mockQuery.mockResolvedValue({json: async () => []})
    for (const sql of ['SHOW TABLES', 'DESCRIBE t', 'EXISTS TABLE t', 'WITH x AS (1) SELECT x']) {
      await a.raw(sql)
    }
    expect(mockQuery).toHaveBeenCalledTimes(4)
    expect(mockCommand).not.toHaveBeenCalled()
  })

  it('batch-inserts rows and no-ops on empty input', async () => {
    const a = new ClickHouseAdapter({}, 'k')
    await a.insert('events', [{a: 1}, {a: 2}])
    expect(mockInsert).toHaveBeenCalledWith({table: 'events', values: [{a: 1}, {a: 2}], format: 'JSONEachRow'})

    mockInsert.mockClear()
    await a.insert('events', [])
    expect(mockInsert).not.toHaveBeenCalled()
  })

  it('hasTable() interprets EXISTS TABLE result', async () => {
    const a = new ClickHouseAdapter({}, 'k')
    mockQuery.mockResolvedValueOnce({json: async () => [{result: 1}]})
    expect(await a.hasTable('events')).toBe(true)

    mockQuery.mockResolvedValueOnce({json: async () => [{result: 0}]})
    expect(await a.hasTable('missing')).toBe(false)
  })

  it('columnInfo() normalizes system.columns rows and unwraps Nullable', async () => {
    const a = new ClickHouseAdapter({}, 'k')
    mockQuery.mockResolvedValueOnce({
      json: async () => [
        {name: 'id', type: 'String', default_expression: ''},
        {name: 'note', type: 'Nullable(String)', default_expression: ''},
        {name: 'count', type: 'Int32', default_expression: '0'}
      ]
    })
    const info = await a.columnInfo('events')
    expect(info.id).toEqual({type: 'String', nullable: false, defaultValue: null})
    expect(info.note).toEqual({type: 'String', nullable: true, defaultValue: null})
    expect(info.count).toEqual({type: 'Int32', nullable: false, defaultValue: '0'})
  })

  it('destroy() closes the client only if opened', async () => {
    const a = new ClickHouseAdapter({}, 'k')
    await a.destroy()
    expect(mockClose).not.toHaveBeenCalled()

    mockQuery.mockResolvedValue({json: async () => []})
    await a.query('SELECT 1')
    await a.destroy()
    expect(mockClose).toHaveBeenCalledTimes(1)
  })
})
