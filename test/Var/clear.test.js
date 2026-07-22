const Var = require('../../src/Var')

// clear() removes its arguments from the value. It must treat them as LITERAL
// substrings: building a RegExp from raw input crashes on invalid patterns and
// is a ReDoS vector. See IMPROVEMENT-PLAN 2.5.

describe('Var.clear()', () => {
  it('removes all occurrences of a literal substring', () => {
    expect(new Var('a-b-c-d').clear('-')).toBe('abcd')
  })

  it('removes multiple literal substrings', () => {
    expect(new Var('foo[bar](baz)').clear('[', ']', '(', ')')).toBe('foobarbaz')
  })

  it('does not throw on regex-special input (unbalanced bracket)', () => {
    // '[' is an invalid RegExp on its own — old code threw SyntaxError here.
    expect(() => new Var('a[b[c').clear('[')).not.toThrow()
    expect(new Var('a[b[c').clear('[')).toBe('abc')
  })

  it('treats input literally, not as a regex pattern', () => {
    // '.' must remove literal dots, not "any character".
    expect(new Var('a.b.c').clear('.')).toBe('abc')
    expect(new Var('a.b.c').clear('x')).toBe('a.b.c')
  })

  it('does not hang or throw on a ReDoS-style pattern', () => {
    expect(() => new Var('aaaaaaaaaa!').clear('(a+)+$')).not.toThrow()
  })
})
