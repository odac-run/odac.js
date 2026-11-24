'use strict'

// incrBy on the redis driver: a ttl must be applied in the same atomic step as the increment,
// once, when the counter has no expiry yet. The eval mock runs the script's logic on a Map.

const store = new Map()
const mockClient = {
  connect: jest.fn().mockResolvedValue(undefined),
  duplicate: jest.fn(() => ({connect: jest.fn().mockResolvedValue(undefined), quit: jest.fn().mockResolvedValue(undefined)})),
  eval: jest.fn(async (script, {keys: [key], arguments: [delta, ttl]}) => {
    if (Number(delta) < 0 && !store.has(key)) return 0
    const entry = store.get(key) ?? {value: 0, ttl: -1}
    entry.value += Number(delta)
    if (entry.value <= 0) {
      store.delete(key)
      return 0
    }
    if (entry.ttl === -1) entry.ttl = Number(ttl)
    store.set(key, entry)
    return String(entry.value)
  }),
  expire: jest.fn().mockResolvedValue(1),
  incrByFloat: jest.fn(),
  quit: jest.fn().mockResolvedValue(undefined),
  set: jest.fn().mockResolvedValue('OK')
}

jest.mock('redis', () => ({createClient: jest.fn(() => mockClient)}), {virtual: true})

let Ipc

beforeEach(async () => {
  store.clear()
  jest.clearAllMocks()
  jest.resetModules()
  Ipc = require('../../src/Ipc')
  global.Odac = {Config: {ipc: {driver: 'redis'}}}
  await Ipc.init()
})

afterEach(async () => {
  await Ipc.close()
  delete global.Odac
})

describe('Ipc redis - incrBy()', () => {
  it('increments and sets the expiry in one script when the counter is created', async () => {
    await expect(Ipc.incrBy('rate', 1, 60)).resolves.toBe(1)
    expect(mockClient.eval).toHaveBeenCalledWith(expect.stringContaining('INCRBYFLOAT'), {keys: ['rate'], arguments: ['1', '60']})
    expect(mockClient.expire).not.toHaveBeenCalled()
    expect(store.get('rate').ttl).toBe(60)
  })

  it('does not extend the expiry on later increments', async () => {
    store.set('rate', {value: 2, ttl: 42})
    await expect(Ipc.incrBy('rate', 1, 60)).resolves.toBe(3)
    expect(store.get('rate').ttl).toBe(42)
  })

  it('gives a counter left without an expiry the window', async () => {
    store.set('rate', {value: 7, ttl: -1})
    await Ipc.incrBy('rate', 1, 60)
    expect(store.get('rate').ttl).toBe(60)
  })

  it('keeps the window on a negative delta', async () => {
    store.set('rate', {value: 3, ttl: 42})
    await expect(Ipc.incrBy('rate', -1, 60)).resolves.toBe(2)
    expect(store.get('rate').ttl).toBe(42)
  })

  it('never lets a negative delta open a window below zero', async () => {
    await expect(Ipc.incrBy('rate', -1, 60)).resolves.toBe(0)
    expect(store.has('rate')).toBe(false)
    const script = mockClient.eval.mock.calls[0][0]
    expect(script).toContain("redis.call('EXISTS', KEYS[1]) == 0 then return 0")
    expect(script).toContain("redis.call('DEL', KEYS[1])")
  })

  it('never sets an expiry without a ttl', async () => {
    mockClient.incrByFloat.mockResolvedValue('1')
    await expect(Ipc.incrBy('counter', 1)).resolves.toBe(1)
    expect(mockClient.incrByFloat).toHaveBeenCalledWith('counter', 1)
    expect(mockClient.eval).not.toHaveBeenCalled()
    expect(mockClient.expire).not.toHaveBeenCalled()
  })
})

describe('Ipc redis - set()', () => {
  it('passes the ttl as a node-redis options object', async () => {
    await Ipc.set('cached', {a: 1}, 30)
    expect(mockClient.set).toHaveBeenCalledWith('cached', '{"a":1}', {EX: 30})
  })

  it('sets no expiry without a ttl', async () => {
    await Ipc.set('kept', 1)
    expect(mockClient.set).toHaveBeenCalledWith('kept', '1')
  })
})
