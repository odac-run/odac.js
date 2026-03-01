const {resolveClient} = require('../../../src/Database/ConnectionFactory')

describe('ConnectionFactory.resolveClient()', () => {
  it('should map known database aliases', () => {
    expect(resolveClient('postgres')).toBe('pg')
    expect(resolveClient('postgresql')).toBe('pg')
    expect(resolveClient('pg')).toBe('pg')
    expect(resolveClient('sqlite')).toBe('sqlite3')
    expect(resolveClient('sqlite3')).toBe('sqlite3')
    expect(resolveClient('mysql')).toBe('mysql2')
  })
})
