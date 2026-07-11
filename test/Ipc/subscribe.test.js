'use strict'

const cluster = require('node:cluster')

/**
 * Tests Ipc pub/sub subscription lifecycle on the memory driver.
 * Why: A channel routinely carries several independent consumers (e.g. a long-lived stats
 * listener and a short-lived ack listener on the same stream). Removing one must never
 * silently leak it, nor take the co-tenants down with it.
 */

let Ipc
let originalSend

beforeEach(async () => {
  jest.resetModules()
  // Subscriptions are a worker-side concern: the Primary only tracks which workers listen.
  Object.defineProperty(cluster, 'isPrimary', {value: false, configurable: true})
  originalSend = process.send
  process.send = jest.fn()

  Ipc = require('../../src/Ipc')
  global.Odac = {Config: {}}
  await Ipc.init()
})

afterEach(async () => {
  await Ipc.close()
  process.removeAllListeners('message')
  process.send = originalSend
  delete global.Odac
})

/** Simulates the Primary forwarding a published message down to this worker. */
const deliver = (channel, message) => process.emit('message', {type: 'ipc:message', channel, message})

describe('Ipc - subscribe()', () => {
  it('should deliver messages to the subscriber', async () => {
    const cb = jest.fn()
    await Ipc.subscribe('chan', cb)

    deliver('chan', {hello: 'world'})

    expect(cb).toHaveBeenCalledWith({hello: 'world'})
  })

  it('should fan out to every subscriber on the same channel', async () => {
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
  })

  it('should return a handle that removes only its own subscription', async () => {
    const stats = jest.fn()
    const ack = jest.fn()
    await Ipc.subscribe('stream', stats)
    const ackSub = await Ipc.subscribe('stream', ack)

    await ackSub.unsubscribe()
    deliver('stream', 'tick')

    expect(ack).not.toHaveBeenCalled()
    expect(stats).toHaveBeenCalledWith('tick')
  })
})

describe('Ipc - unsubscribe()', () => {
  it('should stop delivering to the removed callback', async () => {
    const cb = jest.fn()
    await Ipc.subscribe('chan', cb)
    await Ipc.unsubscribe('chan', cb)

    deliver('chan', 'tick')

    expect(cb).not.toHaveBeenCalled()
  })

  it('should keep co-tenants on the channel alive', async () => {
    const stats = jest.fn()
    const ack = jest.fn()
    await Ipc.subscribe('stream', stats)
    await Ipc.subscribe('stream', ack)

    await Ipc.unsubscribe('stream', ack)
    deliver('stream', 'tick')

    expect(ack).not.toHaveBeenCalled()
    expect(stats).toHaveBeenCalledWith('tick')
  })

  it('should tell the Primary only once the last subscriber leaves', async () => {
    const stats = jest.fn()
    const ack = jest.fn()
    await Ipc.subscribe('stream', stats)
    await Ipc.subscribe('stream', ack)

    const sentUnsub = () => process.send.mock.calls.filter(([m]) => m.type === 'ipc:unsubscribe').length

    await Ipc.unsubscribe('stream', ack)
    expect(sentUnsub()).toBe(0)

    await Ipc.unsubscribe('stream', stats)
    expect(sentUnsub()).toBe(1)
  })

  it('should warn and do nothing when the callback is omitted', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
    const stats = jest.fn()
    await Ipc.subscribe('stream', stats)

    await Ipc.unsubscribe('stream')
    deliver('stream', 'tick')

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('without a callback'))
    expect(stats).toHaveBeenCalledWith('tick')
    warn.mockRestore()
  })

  it('should ignore an unknown channel', async () => {
    await expect(Ipc.unsubscribe('never-subscribed', jest.fn())).resolves.toBeUndefined()
  })
})

describe('Ipc - unsubscribeAll()', () => {
  it('should remove every subscriber and notify the Primary', async () => {
    const stats = jest.fn()
    const ack = jest.fn()
    await Ipc.subscribe('stream', stats)
    await Ipc.subscribe('stream', ack)

    await Ipc.unsubscribeAll('stream')
    deliver('stream', 'tick')

    expect(stats).not.toHaveBeenCalled()
    expect(ack).not.toHaveBeenCalled()
    expect(process.send).toHaveBeenCalledWith(expect.objectContaining({type: 'ipc:unsubscribe', channel: 'stream'}))
  })

  it('should not notify the Primary for a channel it never joined', async () => {
    await Ipc.unsubscribeAll('never-subscribed')

    expect(process.send).not.toHaveBeenCalledWith(expect.objectContaining({type: 'ipc:unsubscribe'}))
  })
})
