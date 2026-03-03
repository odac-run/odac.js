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
})
