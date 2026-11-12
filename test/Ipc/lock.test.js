'use strict'

const cluster = require('node:cluster')

/**
 * Tests Ipc distributed lock: lock() and unlock().
 * Why: Validates that only one process can hold the flush lock at a time,
 * preventing duplicate writes in horizontal scaling scenarios.
 */

let Ipc

beforeEach(async () => {
  jest.resetModules()
  Object.defineProperty(cluster, 'isPrimary', {value: true, configurable: true})

  Ipc = require('../../src/Ipc')
  global.Odac = {Config: {}}
  await Ipc.init()
})

afterEach(async () => {
  await Ipc.close()
  delete global.Odac
})

describe('Ipc - lock()', () => {
  it('should acquire lock and return true', async () => {
    const result = await Ipc.lock('lock:a', 5)
    expect(result).toBe(true)
  })

  it('should reject second acquisition (mutex)', async () => {
    await Ipc.lock('lock:b', 5)
    const result = await Ipc.lock('lock:b', 5)
    expect(result).toBe(false)
  })

  it('should allow re-acquisition after unlock', async () => {
    await Ipc.lock('lock:c', 5)
    await Ipc.unlock('lock:c')
    const result = await Ipc.lock('lock:c', 5)
    expect(result).toBe(true)
  })

  it('should auto-expire after TTL', async () => {
    await Ipc.lock('lock:d', 1) // 1 second TTL

    // Wait for expiry
    await new Promise(r => setTimeout(r, 1100))

    // Lock should be available again
    const result = await Ipc.lock('lock:d', 5)
    expect(result).toBe(true)
  })

  it('should not interfere with different lock keys', async () => {
    await Ipc.lock('lock:e', 5)
    const result = await Ipc.lock('lock:f', 5)
    expect(result).toBe(true)
  })
})

describe('Ipc - lock ownership', () => {
  it('releases a lock only for its owner', async () => {
    await Ipc.lock('lock:own', 5, 'owner-a')

    expect(await Ipc.unlock('lock:own', 'owner-b')).toBe(false)
    expect(await Ipc.lock('lock:own', 5, 'owner-b')).toBe(false)
    expect(await Ipc.unlock('lock:own', 'owner-a')).toBe(true)
    expect(await Ipc.lock('lock:own', 5, 'owner-b')).toBe(true)
  })

  it('extends a lock only for its owner', async () => {
    await Ipc.lock('lock:ext', 1, 'owner-a')

    expect(await Ipc.extendLock('lock:ext', 'owner-b', 5)).toBe(false)
    expect(await Ipc.extendLock('lock:ext', 'owner-a', 5)).toBe(true)
    await new Promise(r => setTimeout(r, 1100))
    expect(await Ipc.lock('lock:ext', 5, 'owner-b')).toBe(false)
  })

  it('force-releases a lock whoever holds it', async () => {
    await Ipc.lock('lock:force', 5, 'owner-a')
    expect(await Ipc.forceUnlock('lock:force')).toBe(true)
    expect(await Ipc.lock('lock:force', 5, 'owner-b')).toBe(true)
  })

  it("does not release another holder's lock through unlock(key) without an owner", async () => {
    await Ipc.lock('lock:other', 5, 'owner-a')
    expect(await Ipc.unlock('lock:other')).toBe(false)
    expect(await Ipc.lock('lock:other', 5, 'owner-b')).toBe(false)
  })

  it('checks ownership for the lock(key) ... unlock(key) pattern', async () => {
    const realNow = Date.now
    expect(await Ipc.lock('lock:job', 1)).toBe(true)
    // The first holder outlives its TTL and another process takes the lock.
    jest.spyOn(Date, 'now').mockReturnValue(realNow() + 2000)
    expect(await Ipc.lock('lock:job', 30, 'second-process')).toBe(true)

    // The late unlock() must not delete the second holder's lock.
    expect(await Ipc.unlock('lock:job')).toBe(false)
    expect(await Ipc.lock('lock:job', 30, 'third')).toBe(false)
    jest.restoreAllMocks()
  })

  it('releases its own lock(key) with unlock(key)', async () => {
    expect(await Ipc.lock('lock:own', 5)).toBe(true)
    expect(await Ipc.unlock('lock:own')).toBe(true)
    expect(await Ipc.lock('lock:own', 5)).toBe(true)
  })
})
