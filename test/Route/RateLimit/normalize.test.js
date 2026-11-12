const RateLimit = require('../../../src/Route/RateLimit.js')

// A bad declaration must fail when the route file loads, not on the first request.
describe('RateLimit.normalize()', () => {
  it('defaults the window to one minute and the key to the client IP', () => {
    expect(RateLimit.normalize({max: 10}, 'www:post:/send')).toEqual({max: 10, window: 60000, key: null, scope: 'www:post:/send'})
  })

  it('keeps a custom window and key function', () => {
    const key = () => 'k'
    const limit = RateLimit.normalize({max: 5, window: 1000, key}, 's')

    expect(limit.window).toBe(1000)
    expect(limit.key).toBe(key)
  })

  it('returns a frozen object so a shared limit cannot be mutated at runtime', () => {
    expect(Object.isFrozen(RateLimit.normalize({max: 1}, 's'))).toBe(true)
  })

  it.each([[undefined], [null], ['10'], [5]])('rejects a non-object declaration (%p)', value => {
    expect(() => RateLimit.normalize(value, 's')).toThrow(TypeError)
  })

  it.each([[0], [-1], [1.5], ['10'], [undefined], [NaN]])('rejects max = %p', max => {
    expect(() => RateLimit.normalize({max}, 's')).toThrow(/rateLimit.max/)
  })

  it.each([[0], [-1000], [1.5], ['60000'], [null]])('rejects window = %p', window => {
    expect(() => RateLimit.normalize({max: 1, window}, 's')).toThrow(/rateLimit.window/)
  })

  it('rejects a key that is not a function', () => {
    expect(() => RateLimit.normalize({max: 1, key: 'ip'}, 's')).toThrow(/rateLimit.key/)
  })
})
