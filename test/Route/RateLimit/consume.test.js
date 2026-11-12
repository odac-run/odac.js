'use strict'

const cluster = require('node:cluster')

// consume() counts through Odac.Ipc so the limit is shared by every worker.
// The memory driver runs in-process here (isPrimary), the same store the
// primary keeps for all workers.

let Ipc
let RateLimit

function makeOdac({ip = '203.0.113.7', user = null} = {}) {
  const headers = {}
  return {
    Ipc,
    Auth: {user: () => user},
    Request: {
      ip,
      headers,
      header: jest.fn((name, value) => {
        headers[name] = value
      }),
      abort: jest.fn(async () => {})
    }
  }
}

beforeEach(async () => {
  jest.resetModules()
  Object.defineProperty(cluster, 'isPrimary', {value: true, configurable: true})
  Ipc = require('../../../src/Ipc')
  RateLimit = require('../../../src/Route/RateLimit.js')
  global.Odac = {Config: {}}
  await Ipc.init()
  jest.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(async () => {
  jest.useRealTimers()
  jest.restoreAllMocks()
  await Ipc.close()
  delete global.Odac
})

describe('RateLimit.consume()', () => {
  it('allows requests up to max and answers 429 after that', async () => {
    const limit = RateLimit.normalize({max: 2, window: 60000}, 'www:post:/send')

    const results = []
    for (let i = 0; i < 3; i++) {
      const Odac = makeOdac()
      results.push({allowed: await RateLimit.consume(Odac, limit), Odac})
    }

    expect(results.map(r => r.allowed)).toEqual([true, true, false])
    expect(results[0].Odac.Request.abort).not.toHaveBeenCalled()
    expect(results[2].Odac.Request.abort).toHaveBeenCalledWith(429)
  })

  it('sets the RateLimit headers and Retry-After on rejection', async () => {
    jest.useFakeTimers({now: 60000 * 1000 + 15000, doNotFake: ['setImmediate', 'nextTick']})
    const limit = RateLimit.normalize({max: 1, window: 60000}, 's')

    const first = makeOdac()
    await RateLimit.consume(first, limit)
    const second = makeOdac()
    await RateLimit.consume(second, limit)

    expect(first.Request.headers).toEqual({'RateLimit-Limit': '1', 'RateLimit-Remaining': '0', 'RateLimit-Reset': '45'})
    expect(second.Request.headers).toEqual({
      'RateLimit-Limit': '1',
      'RateLimit-Remaining': '0',
      'RateLimit-Reset': '45',
      'Retry-After': '45'
    })
  })

  it('counts each client IP separately', async () => {
    const limit = RateLimit.normalize({max: 1}, 's')

    expect(await RateLimit.consume(makeOdac({ip: '198.51.100.1'}), limit)).toBe(true)
    expect(await RateLimit.consume(makeOdac({ip: '198.51.100.2'}), limit)).toBe(true)
    expect(await RateLimit.consume(makeOdac({ip: '198.51.100.1'}), limit)).toBe(false)
  })

  it('keeps separate budgets per scope', async () => {
    const a = RateLimit.normalize({max: 1}, 'www:post:/a')
    const b = RateLimit.normalize({max: 1}, 'www:post:/b')

    expect(await RateLimit.consume(makeOdac(), a)).toBe(true)
    expect(await RateLimit.consume(makeOdac(), b)).toBe(true)
    expect(await RateLimit.consume(makeOdac(), a)).toBe(false)
  })

  it('starts a fresh budget in the next window', async () => {
    jest.useFakeTimers({now: 1000 * 1000, doNotFake: ['setImmediate', 'nextTick']})
    const limit = RateLimit.normalize({max: 1, window: 1000}, 's')

    expect(await RateLimit.consume(makeOdac(), limit)).toBe(true)
    expect(await RateLimit.consume(makeOdac(), limit)).toBe(false)
    jest.setSystemTime(1001 * 1000)

    expect(await RateLimit.consume(makeOdac(), limit)).toBe(true)
  })

  it('counts by a custom key instead of the IP', async () => {
    const limit = RateLimit.normalize({max: 1, key: Odac => Odac.Auth.user()?.id}, 's')

    expect(await RateLimit.consume(makeOdac({ip: '1.1.1.1', user: {id: 7}}), limit)).toBe(true)
    expect(await RateLimit.consume(makeOdac({ip: '2.2.2.2', user: {id: 7}}), limit)).toBe(false)
    expect(await RateLimit.consume(makeOdac({ip: '1.1.1.1', user: {id: 8}}), limit)).toBe(true)
  })

  it.each([[null], [undefined], ['']])('exempts a request whose key is %p', async value => {
    const limit = RateLimit.normalize({max: 1, key: () => value}, 's')
    const ipc = jest.spyOn(Ipc, 'incrBy')

    for (let i = 0; i < 3; i++) expect(await RateLimit.consume(makeOdac(), limit)).toBe(true)
    expect(ipc).not.toHaveBeenCalled()
  })

  it('hashes the key so client-controlled values cannot grow store keys', async () => {
    const ipc = jest.spyOn(Ipc, 'incrBy')
    const limit = RateLimit.normalize({max: 1, window: 30000, key: () => 'x'.repeat(10000)}, 's')

    await RateLimit.consume(makeOdac(), limit)

    const [key, delta, ttl] = ipc.mock.calls[0]
    expect(key).toMatch(/^odac:ratelimit:[A-Za-z0-9_-]{43}:\d+$/)
    expect(delta).toBe(1)
    expect(ttl).toBe(30)
  })

  it('rounds a sub-second window up to a one-second expiry', async () => {
    const ipc = jest.spyOn(Ipc, 'incrBy')

    await RateLimit.consume(makeOdac(), RateLimit.normalize({max: 1, window: 250}, 's'))

    expect(ipc.mock.calls[0][2]).toBe(1)
  })

  // A throttle must not turn an IPC outage into a full outage.
  it('lets the request through and logs when the counter store fails', async () => {
    jest.spyOn(Ipc, 'incrBy').mockRejectedValue(new Error('IPC shutting down'))
    const Odac = makeOdac()

    expect(await RateLimit.consume(Odac, RateLimit.normalize({max: 1}, 's'))).toBe(true)
    expect(Odac.Request.abort).not.toHaveBeenCalled()
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('IPC shutting down'))
  })

  it('lets the request through and logs when the key function throws', async () => {
    const limit = RateLimit.normalize(
      {
        max: 1,
        key: () => {
          throw new Error('key bug')
        }
      },
      's'
    )

    expect(await RateLimit.consume(makeOdac(), limit)).toBe(true)
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('key bug'))
  })
})
