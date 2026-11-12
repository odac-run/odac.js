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

describe('Config._deepMerge() hardening', () => {
  it('never writes to Object.prototype through __proto__', () => {
    Config._deepMerge({}, JSON.parse('{"__proto__": {"polluted": true}, "a": {"__proto__": {"polluted": true}}}'))
    expect({}.polluted).toBeUndefined()
  })

  it('drops constructor and prototype keys', () => {
    const target = {}
    Config._deepMerge(target, JSON.parse('{"constructor": {"prototype": {"x": 1}}, "prototype": 1}'))
    expect(Object.prototype.hasOwnProperty.call(target, 'prototype')).toBe(false)
    expect({}.x).toBeUndefined()
  })

  it('does not replace methods with config values', () => {
    const target = {init: () => 'kept', value: 1}
    Config._deepMerge(target, {init: 'oops', value: 2})
    expect(target.init()).toBe('kept')
    expect(target.value).toBe(2)
  })
})
