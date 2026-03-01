const Config = require('../../src/Config')

describe('Config._deepMerge()', () => {
  it('should merge objects deeply', () => {
    const target = {a: {b: 1}, c: 2}
    const source = {a: {d: 3}, e: 4}
    Config._deepMerge(target, source)
    expect(target).toEqual({
      a: {b: 1, d: 3},
      c: 2,
      e: 4
    })
  })
})
