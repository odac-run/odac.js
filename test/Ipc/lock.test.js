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
