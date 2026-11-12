const Var = require('../../src/Var')

// replace() is used to fill templates, so every occurrence must change, the documented
// two-argument form must work and replacement values are inserted literally.

describe('Var.replace()', () => {
  it('supports the two-argument form', () => {
    expect(new Var('hello world').replace('world', 'universe')).toBe('hello universe')
  })

  it('replaces every occurrence of each key', () => {
    expect(new Var('{{a}} and {{a}}, {{b}}').replace({'{{a}}': 'x', '{{b}}': 'y'})).toBe('x and x, y')
  })

  it('inserts replacement values literally', () => {
    expect(new Var('price: P').replace('P', '$& $1 $$')).toBe('price: $& $1 $$')
  })

  it('walks objects and keeps arrays as arrays', () => {
    const result = new Var({title: 'Hi {{n}}', list: ['{{n}}', 1], nested: {x: '{{n}}'}, none: null}).replace({'{{n}}': 'Jo'})
    expect(result).toEqual({title: 'Hi Jo', list: ['Jo', 1], nested: {x: 'Jo'}, none: null})
    expect(Array.isArray(result.list)).toBe(true)
  })

  it('returns non-string values unchanged and ignores empty search strings', () => {
    expect(new Var(42).replace('4', '5')).toBe(42)
    expect(new Var('abc').replace('', 'x')).toBe('abc')
  })
})

describe('Var.slug()', () => {
  it.each([
    ['Hello World!', 'hello-world'],
    ['Product Name 2024', 'product-name-2024'],
    ['Çağrı Şükür İyi Öğün', 'cagri-sukur-iyi-ogun'],
    ['café résumé', 'cafe-resume'],
    ['Straße Łódź', 'strasse-lodz'],
    ['  --a__b--  ', 'a-b'],
    ['!!!', '']
  ])('%p → %p', (input, expected) => {
    expect(new Var(input).slug()).toBe(expected)
  })

  it('uses a custom separator and collapses runs of it', () => {
    expect(new Var('Hello   World').slug('_')).toBe('hello_world')
  })
})
