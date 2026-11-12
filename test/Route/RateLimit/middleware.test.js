const RateLimit = require('../../../src/Route/RateLimit.js')

// One middleware instance is one budget, shared by every route it wraps.
describe('RateLimit.middleware()', () => {
  let store

  function makeOdac() {
    return {
      Ipc: {incrBy: jest.fn(async key => store.set(key, (store.get(key) ?? 0) + 1).get(key))},
      Request: {ip: '203.0.113.7', header: jest.fn(), abort: jest.fn(async () => {})}
    }
  }

  beforeEach(() => {
    store = new Map()
  })

  it('continues the chain while under the limit and stops it after', async () => {
    const mw = RateLimit.middleware({max: 1})

    expect(await mw(makeOdac())).toBeUndefined()
    const rejected = makeOdac()
    expect(await mw(rejected)).toBe(false)
    expect(rejected.Request.abort).toHaveBeenCalledWith(429)
  })

  it('gives separate limiters separate budgets', async () => {
    const a = RateLimit.middleware({max: 1})
    const b = RateLimit.middleware({max: 1})

    await a(makeOdac())

    expect(await b(makeOdac())).toBeUndefined()
  })

  it('shares a budget between limiters with the same name', async () => {
    const a = RateLimit.middleware({max: 1, name: 'uploads'})
    const b = RateLimit.middleware({max: 1, name: 'uploads'})

    await a(makeOdac())

    expect(await b(makeOdac())).toBe(false)
  })

  it.each([[''], [42]])('rejects an invalid name (%p)', name => {
    expect(() => RateLimit.middleware({max: 1, name})).toThrow(/rateLimit.name/)
  })

  it('validates the limit when the middleware is created', () => {
    expect(() => RateLimit.middleware({max: 0})).toThrow(/rateLimit.max/)
  })
})
