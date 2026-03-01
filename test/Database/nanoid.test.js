const DB = require('../../src/Database')

describe('Database.nanoid()', () => {
  it('should generate a string of default length (21)', () => {
    const id = DB.nanoid()
    expect(typeof id).toBe('string')
    expect(id.length).toBe(21)
  })

  it('should generate a string of specified length', () => {
    const id = DB.nanoid(10)
    expect(id.length).toBe(10)
  })

  it('should generate only alphanumeric characters', () => {
    const id = DB.nanoid(100)
    expect(id).toMatch(/^[a-zA-Z0-9]+$/)
  })
})
