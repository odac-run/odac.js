const {buildConnectionConfig} = require('../../../src/Database/ConnectionFactory')

describe('ConnectionFactory.buildConnectionConfig()', () => {
  it('should create sqlite filename config', () => {
    const config = buildConnectionConfig({database: 'db.sqlite3'}, 'sqlite3')
    expect(config).toEqual({filename: 'db.sqlite3'})
  })

  it('should create host based config for non-sqlite', () => {
    const config = buildConnectionConfig({user: 'root', password: 'secret', database: 'app', port: 3306}, 'mysql2')
    expect(config).toEqual({host: '127.0.0.1', user: 'root', password: 'secret', database: 'app', port: 3306})
  })

  it('passes TLS, character set and time zone to mysql2', () => {
    const config = buildConnectionConfig({database: 'app', ssl: true, charset: 'utf8mb4', timezone: 'Z'}, 'mysql2')
    expect(config).toMatchObject({ssl: {}, charset: 'utf8mb4', timezone: 'Z'})
  })

  it('passes an ssl object through unchanged', () => {
    const ssl = {ca: 'CERT', rejectUnauthorized: true}
    expect(buildConnectionConfig({ssl}, 'pg').ssl).toBe(ssl)
    expect(buildConnectionConfig({ssl}, 'mysql2').ssl).toBe(ssl)
  })

  it('uses a connection URL instead of host defaults', () => {
    expect(buildConnectionConfig({url: 'postgres://u:p@db.example:5432/app', ssl: true}, 'pg')).toEqual({
      connectionString: 'postgres://u:p@db.example:5432/app',
      ssl: true
    })
    expect(buildConnectionConfig({connectionString: 'mysql://u:p@db.example/app'}, 'mysql2')).toEqual({uri: 'mysql://u:p@db.example/app'})
  })

  it('sets the PostgreSQL session time zone and rejects unsafe values', () => {
    expect(buildConnectionConfig({timezone: 'Europe/Istanbul'}, 'pg').options).toBe('-c TimeZone=Europe/Istanbul')
    expect(() => buildConnectionConfig({timezone: 'UTC -c search_path=evil'}, 'pg')).toThrow(/Invalid database timezone/)
  })

  it('merges extra driver options as given', () => {
    expect(buildConnectionConfig({options: {connectTimeout: 5000, flags: ['-FOUND_ROWS']}}, 'mysql2')).toMatchObject({
      connectTimeout: 5000,
      flags: ['-FOUND_ROWS']
    })
  })

  it('does not pass unknown top-level keys to the driver', () => {
    const config = buildConnectionConfig({type: 'mysql', connectionLimit: 5, charset: 'utf8mb4'}, 'pg')
    expect(config).not.toHaveProperty('type')
    expect(config).not.toHaveProperty('connectionLimit')
    expect(config).not.toHaveProperty('charset')
  })
})
