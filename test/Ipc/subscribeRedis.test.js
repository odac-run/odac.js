'use strict'

/**
 * Tests Ipc pub/sub on the redis driver.
 * Why: node-redis v4+ delivers messages to a listener passed to subscribe() and emits no
 * client-wide 'message' event, so the bridge must be wired per channel. These tests pin
 * that wiring and assert the driver removes subscriptions with the same per-callback
 * semantics as the memory driver.
 */

// Channel -> the listener node-redis was handed. Lets a test push a message the way a real
// server would, without a live Redis.
const mockChannels = new Map()

const mockSubClient = {
  connect: jest.fn().mockResolvedValue(undefined),
  subscribe: jest.fn(async (channel, listener) => mockChannels.set(channel, listener)),
  unsubscribe: jest.fn(async channel => mockChannels.delete(channel)),
  quit: jest.fn().mockResolvedValue(undefined)
}

const mockClient = {
  connect: jest.fn().mockResolvedValue(undefined),
  duplicate: jest.fn(() => mockSubClient),
  publish: jest.fn().mockResolvedValue(1),
  quit: jest.fn().mockResolvedValue(undefined)
}

jest.mock('redis', () => ({createClient: jest.fn(() => mockClient)}), {virtual: true})

let Ipc

beforeEach(async () => {
  jest.clearAllMocks()
  jest.resetModules()
  mockChannels.clear()

  Ipc = require('../../src/Ipc')
  global.Odac = {Config: {ipc: {driver: 'redis'}}}
  await Ipc.init()
})

afterEach(async () => {
  await Ipc.close()
  delete global.Odac
})

/** Simulates Redis pushing a message on a channel, as node-redis would. */
const deliver = (channel, message) => mockChannels.get(channel)?.(JSON.stringify(message), channel)

describe('Ipc redis - subscribe()', () => {
  it('should register a listener with redis and deliver parsed messages', async () => {
    const cb = jest.fn()
    await Ipc.subscribe('chan', cb)

    expect(mockSubClient.subscribe).toHaveBeenCalledWith('chan', expect.any(Function))

    deliver('chan', {hello: 'world'})
    expect(cb).toHaveBeenCalledWith({hello: 'world'})
  })

  it('should subscribe to a channel only once, however many consumers join', async () => {
    await Ipc.subscribe('stream', jest.fn())
    await Ipc.subscribe('stream', jest.fn())

    expect(mockSubClient.subscribe).toHaveBeenCalledTimes(1)
  })

  it('should fan out to every consumer on the same channel', async () => {
    const stats = jest.fn()
    const ack = jest.fn()
    await Ipc.subscribe('stream', stats)
    await Ipc.subscribe('stream', ack)

    deliver('stream', 'tick')

    expect(stats).toHaveBeenCalledWith('tick')
    expect(ack).toHaveBeenCalledWith('tick')
  })

  it('should reject a missing callback instead of registering undefined', async () => {
    await expect(Ipc.subscribe('chan')).rejects.toThrow(TypeError)
    expect(mockSubClient.subscribe).not.toHaveBeenCalled()
  })
})

describe('Ipc redis - unsubscribe()', () => {
  it('should keep co-tenants alive and hold the redis subscription open', async () => {
    const stats = jest.fn()
    const ack = jest.fn()
    await Ipc.subscribe('stream', stats)
    const ackSub = await Ipc.subscribe('stream', ack)

    await ackSub.unsubscribe()

    expect(mockSubClient.unsubscribe).not.toHaveBeenCalled()

    deliver('stream', 'tick')
    expect(ack).not.toHaveBeenCalled()
    expect(stats).toHaveBeenCalledWith('tick')
  })

  it('should drop the redis subscription once the last consumer leaves', async () => {
    const stats = jest.fn()
    const ack = jest.fn()
    await Ipc.subscribe('stream', stats)
    await Ipc.subscribe('stream', ack)

    await Ipc.unsubscribe('stream', ack)
    await Ipc.unsubscribe('stream', stats)

    expect(mockSubClient.unsubscribe).toHaveBeenCalledWith('stream', expect.any(Function))
  })

  it('should warn instead of throwing when the callback is omitted', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
    const stats = jest.fn()
    await Ipc.subscribe('stream', stats)

    await expect(Ipc.unsubscribe('stream')).resolves.toBeUndefined()

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('without a callback'))
    deliver('stream', 'tick')
    expect(stats).toHaveBeenCalledWith('tick')
    warn.mockRestore()
  })
})

describe('Ipc redis - unsubscribeAll()', () => {
  it('should remove every consumer and drop the redis subscription', async () => {
    const stats = jest.fn()
    const ack = jest.fn()
    await Ipc.subscribe('stream', stats)
    await Ipc.subscribe('stream', ack)

    await Ipc.unsubscribeAll('stream')

    expect(mockSubClient.unsubscribe).toHaveBeenCalledWith('stream', expect.any(Function))
    expect(Ipc.listenerCount('stream')).toBe(0)
  })
})
