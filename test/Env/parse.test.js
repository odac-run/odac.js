const Env = require('../../src/Env')

describe('Env.parse()', () => {
  it('keeps # inside unquoted values', () => {
    expect(Env.parse('PASSWORD=ab#cd').PASSWORD).toBe('ab#cd')
    expect(Env.parse('COLOR=#fff').COLOR).toBe('#fff')
  })

  it('treats # after whitespace as an inline comment', () => {
    expect(Env.parse('PORT=3000 # http port').PORT).toBe('3000')
    expect(Env.parse('EMPTY= # nothing').EMPTY).toBe('')
  })

  it('ignores comment lines and lines without a key', () => {
    expect(Env.parse('# A=1\n=2\nnoequals\nB=3')).toEqual(Object.assign(Object.create(null), {B: '3'}))
  })

  it('strips the export prefix', () => {
    expect(Env.parse('export API_KEY=secret').API_KEY).toBe('secret')
  })

  it('reads quoted values with a trailing comment', () => {
    const vars = Env.parse('A="x # y" # note\nB=\'z\' #c')
    expect(vars.A).toBe('x # y')
    expect(vars.B).toBe('z')
  })

  it('unescapes double-quoted values in a single pass', () => {
    expect(Env.parse('A="line\\nnext \\"q\\" \\\\n"').A).toBe('line\nnext "q" \\n')
  })

  it('keeps single-quoted values literal', () => {
    expect(Env.parse("A='a\\nb'").A).toBe('a\\nb')
  })

  it('reads multi-line quoted values', () => {
    const vars = Env.parse('KEY="-----BEGIN-----\nabc\n-----END-----"\nNEXT=1')
    expect(vars.KEY).toBe('-----BEGIN-----\nabc\n-----END-----')
    expect(vars.NEXT).toBe('1')
  })

  it('falls back to the raw value when a quote is never closed', () => {
    const vars = Env.parse('A="open\nB=2')
    expect(vars.A).toBe('"open')
    expect(vars.B).toBe('2')
  })

  it('handles CRLF line endings', () => {
    expect(Env.parse('A=1\r\nB="2"\r\n')).toEqual(Object.assign(Object.create(null), {A: '1', B: '2'}))
  })
})
