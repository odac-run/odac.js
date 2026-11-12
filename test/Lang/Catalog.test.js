const Catalog = require('../../src/Lang/Catalog')

describe('Lang Catalog', () => {
  describe('format()', () => {
    it('replaces sequential placeholders in order and leaves extra ones', () => {
      expect(Catalog.format('%s and %s and %s', ['a', 'b'])).toBe('a and b and %s')
    })

    it('replaces numbered placeholders in any order and repeatedly', () => {
      expect(Catalog.format('%s2 %s1 %s2', ['a', 'b'])).toBe('b a b')
    })

    it('does not expand placeholders contained in argument values', () => {
      expect(Catalog.format('%s1 / %s2', ['%s2', 'x'])).toBe('%s2 / x')
      expect(Catalog.format('%s %s', ['%s', 'x'])).toBe('%s x')
    })

    it('does not match %s1 inside %s10', () => {
      const args = Array.from({length: 10}, (_, i) => `v${i + 1}`)
      expect(Catalog.format('%s10-%s1', args)).toBe('v10-v1')
      expect(Catalog.format('%s3 %s0', ['a'])).toBe('%s3 %s0')
    })

    it('keeps replacement patterns literal', () => {
      expect(Catalog.format('Total: %s', ["$& $'"])).toBe("Total: $& $'")
    })
  })

  describe('lookup() / has()', () => {
    const data = Catalog.parse(JSON.stringify({Login: 'Giriş', Empty: '', Gül: {'': 'Gül', verb: 'Gülümse', flower: ''}}))

    it('returns only non-empty translations', () => {
      expect(Catalog.lookup(data, 'Login')).toBe('Giriş')
      expect(Catalog.lookup(data, 'Empty')).toBeUndefined()
      expect(Catalog.lookup(data, 'Gül', 'verb')).toBe('Gülümse')
      expect(Catalog.lookup(data, 'Gül', 'flower')).toBeUndefined()
      expect(Catalog.lookup(data, 'Gül')).toBe('Gül')
      expect(Catalog.lookup(data, 'Login', 'verb')).toBeUndefined()
      expect(Catalog.lookup(data, 'constructor')).toBeUndefined()
    })

    it('reports untranslated entries as present', () => {
      expect(Catalog.has(data, 'Empty')).toBe(true)
      expect(Catalog.has(data, 'Gül', 'flower')).toBe(true)
      expect(Catalog.has(data, 'Gül', 'noun')).toBe(false)
      expect(Catalog.has(data, 'Login', 'verb')).toBe(false)
      expect(Catalog.has(data, 'toString')).toBe(false)
    })
  })

  describe('parse()', () => {
    it('accepts only a JSON object and coerces invalid values to untranslated', () => {
      expect(Object.keys(Catalog.parse('[1,2]'))).toEqual([])
      expect(Object.keys(Catalog.parse('not json'))).toEqual([])
      const data = Catalog.parse('{"a": 1, "b": null, "c": {"x": 2, "y": "ok"}, "d": [1]}')
      expect({...data, c: {...data.c}}).toEqual({a: '', b: '', c: {x: '', y: 'ok'}, d: ''})
    })

    it('keeps __proto__ as an ordinary key', () => {
      const data = Catalog.parse('{"__proto__": "x"}')
      expect(Object.getPrototypeOf(data)).toBeNull()
      expect(Catalog.lookup(data, '__proto__')).toBe('x')
    })
  })

  describe('addEntry()', () => {
    it('turns a string entry into a context object that keeps the original', () => {
      const data = Catalog.parse('{"Gül": "Rose"}')
      expect(Catalog.addEntry(data, 'Gül', 'verb', '')).toBe(true)
      expect({...data.Gül}).toEqual({'': 'Rose', verb: ''})
      expect(Catalog.addEntry(data, 'Gül', 'verb', 'x')).toBe(false)
      expect(Catalog.addEntry(data, 'Gül', '', 'x')).toBe(false)
    })

    it('adds the no-context variant to a context object', () => {
      const data = Catalog.parse('{"Gül": {"verb": "Smile"}}')
      expect(Catalog.addEntry(data, 'Gül', '', 'Gül')).toBe(true)
      expect({...data.Gül}).toEqual({verb: 'Smile', '': 'Gül'})
    })
  })

  describe('build()', () => {
    it('orders keys and contexts deterministically', () => {
      const list = [
        {key: 'b', context: ''},
        {key: 'a', context: 'z'},
        {key: 'a', context: ''},
        {key: 'a', context: 'm'}
      ]
      const data = Catalog.build(list, (key, context) => `${key}:${context}`)
      expect(Catalog.serialize(data)).toBe(`${JSON.stringify({a: {'': 'a:', m: 'a:m', z: 'a:z'}, b: 'b:'}, null, 4)}\n`)
    })
  })

  describe('languages', () => {
    it('validates the default language', () => {
      expect(Catalog.defaultLanguage({lang: {default: 'TR'}})).toBe('tr')
      expect(Catalog.defaultLanguage({lang: {default: 'english'}})).toBe('en')
      expect(Catalog.defaultLanguage(undefined)).toBe('en')
    })

    it('returns null without an explicit supported list', () => {
      expect(Catalog.configuredLanguages({lang: {}})).toBeNull()
      expect(Catalog.configuredLanguages({lang: {supported: 'tr'}})).toBeNull()
    })

    it('knows which languages are written right to left', () => {
      for (const code of ['ar', 'he', 'fa', 'ur']) expect(Catalog.direction(code)).toBe('rtl')
      for (const code of ['tr', 'en', 'ku', undefined]) expect(Catalog.direction(code)).toBe('ltr')
    })

    it('normalizes the context', () => {
      expect(Catalog.normalizeContext(undefined)).toBe('')
      expect(Catalog.normalizeContext('  verb ')).toBe('verb')
      expect(Catalog.normalizeContext('x'.repeat(500))).toHaveLength(100)
    })
  })
})
