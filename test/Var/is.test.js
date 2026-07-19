const Var = require('../../src/Var')

// is('json') must return a boolean: true for valid JSON, false for invalid —
// never throw. See IMPROVEMENT-PLAN 2.5.

describe("Var.is('json')", () => {
  it('returns true for a valid JSON object', () => {
    expect(new Var('{"a":1}').is('json')).toBe(true)
  })

  it('returns true for a valid JSON array', () => {
    expect(new Var('[1,2,3]').is('json')).toBe(true)
  })

  it('returns false for invalid JSON without throwing', () => {
    expect(() => new Var('{not json}').is('json')).not.toThrow()
    expect(new Var('{not json}').is('json')).toBe(false)
  })

  it('returns false for a bare non-JSON string', () => {
    expect(new Var('hello').is('json')).toBe(false)
  })

  it('returns false for an empty string', () => {
    expect(new Var('').is('json')).toBe(false)
  })
})
