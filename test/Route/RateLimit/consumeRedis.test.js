'use strict'

// consume() on the Redis driver: the counter lives in Redis, so the limit
// holds across hosts. The mock keeps counters in a Map like INCRBYFLOAT would.

const counters = new Map()
const mockClient = {
  connect: jest.fn().mockResolvedValue(undefined),
  duplicate: jest.fn(() => ({connect: jest.fn().mockResolvedValue(undefined), quit: jest.fn().mockResolvedValue(undefined)})),
  expire: jest.fn().mockResolvedValue(1),
  incrByFloat: jest.fn(async (key, delta) => {
    const value = (counters.get(key) ?? 0) + delta
    counters.set(key, value)
    return String(value)
  }),
  quit: jest.fn().mockResolvedValue(undefined)
}

jest.mock('redis', () => ({createClient: jest.fn(() => mockClient)}), {virtual: true})

let Ipc
let RateLimit

const makeOdac = () => ({Ipc, Request: {ip: '203.0.113.7', header: jest.fn(), abort: jest.fn(async () => {})}})

beforeEach(async () => {
  counters.clear()
  jest.clearAllMocks()
  jest.resetModules()
  Ipc = require('../../../src/Ipc')
  RateLimit = require('../../../src/Route/RateLimit.js')
  global.Odac = {Config: {ipc: {driver: 'redis'}}}
  await Ipc.init()
})

afterEach(async () => {
  await Ipc.close()
  delete global.Odac
})

describe('RateLimit.consume() on the Redis driver', () => {
  it('rejects once the shared Redis counter passes max', async () => {
    const limit = RateLimit.normalize({max: 2, window: 60000}, 's')

    const allowed = []
    for (let i = 0; i < 3; i++) allowed.push(await RateLimit.consume(makeOdac(), limit))

    expect(allowed).toEqual([true, true, false])
  })

  it('sets the window expiry once, when the counter is created', async () => {
    const limit = RateLimit.normalize({max: 5, window: 60000}, 's')

    await RateLimit.consume(makeOdac(), limit)
    await RateLimit.consume(makeOdac(), limit)

    expect(mockClient.expire).toHaveBeenCalledTimes(1)
    expect(mockClient.expire).toHaveBeenCalledWith(expect.stringMatching(/^odac:ratelimit:/), 60)
  })
})
