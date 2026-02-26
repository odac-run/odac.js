const mockKnex = jest.fn()

jest.mock(
  'knex',
  () =>
    (...args) =>
      mockKnex(...args)
)

const {buildConnections, buildConnectionConfig, resolveClient} = require('../../src/Database/ConnectionFactory')

describe('Database ConnectionFactory', () => {
  beforeEach(() => {
    mockKnex.mockReset()
    mockKnex.mockImplementation(options => ({
      options,
      raw: jest.fn()
    }))
  })

  it('resolveClient should map known database aliases', () => {
    expect(resolveClient('postgres')).toBe('pg')
    expect(resolveClient('postgresql')).toBe('pg')
    expect(resolveClient('pg')).toBe('pg')
    expect(resolveClient('sqlite')).toBe('sqlite3')
    expect(resolveClient('sqlite3')).toBe('sqlite3')
    expect(resolveClient('mysql')).toBe('mysql2')
  })

  it('buildConnectionConfig should create sqlite filename config', () => {
    const config = buildConnectionConfig({database: 'db.sqlite3'}, 'sqlite3')
    expect(config).toEqual({filename: 'db.sqlite3'})
  })

  it('buildConnectionConfig should create host based config for non-sqlite', () => {
    const config = buildConnectionConfig(
      {
        user: 'root',
        password: 'secret',
        database: 'app',
        port: 3306
      },
      'mysql2'
    )

    expect(config).toEqual({
      host: '127.0.0.1',
      user: 'root',
      password: 'secret',
      database: 'app',
      port: 3306
    })
  })

  it('buildConnections should support single database config', () => {
    const connections = buildConnections({
      type: 'mysql',
      user: 'root',
      database: 'app'
    })

    expect(Object.keys(connections)).toEqual(['default'])
    expect(mockKnex).toHaveBeenCalledTimes(1)
    expect(mockKnex.mock.calls[0][0]).toMatchObject({
      client: 'mysql2',
      pool: {min: 0, max: 10},
      useNullAsDefault: true
    })
  })

  it('buildConnections should support multi database config', () => {
    const connections = buildConnections({
      analytics: {type: 'postgres', user: 'u', database: 'a'},
      default: {type: 'sqlite', filename: './dev.sqlite3'}
    })

    expect(Object.keys(connections).sort()).toEqual(['analytics', 'default'])
    expect(mockKnex).toHaveBeenCalledTimes(2)
  })
})
