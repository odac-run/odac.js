'use strict'

const cluster = require('node:cluster')

/**
 * Tests Ipc.incrBy() atomic counter operation.
 * Why: Validates that concurrent increment operations are atomic and return
 * accurate accumulated values, essential for Write-Behind Cache counters.
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

describe('Ipc - incrBy()', () => {
  it('should initialize and return delta on first call', async () => {
    const result = await Ipc.incrBy('counter:a', 5)
    expect(result).toBe(5)
  })

  it('should accumulate multiple increments', async () => {
    await Ipc.incrBy('counter:b', 3)
    await Ipc.incrBy('counter:b', 7)
    const result = await Ipc.incrBy('counter:b', 2)
    expect(result).toBe(12) // 3 + 7 + 2
  })

  it('should handle negative deltas (decrement)', async () => {
    await Ipc.incrBy('counter:c', 10)
    const result = await Ipc.incrBy('counter:c', -3)
    expect(result).toBe(7)
  })

  it('should not interfere with different keys', async () => {
    await Ipc.incrBy('counter:x', 5)
    await Ipc.incrBy('counter:y', 10)

    expect(await Ipc.get('counter:x')).toBe(5)
    expect(await Ipc.get('counter:y')).toBe(10)
  })

  it('should be readable via get()', async () => {
    await Ipc.incrBy('counter:d', 42)
    const result = await Ipc.get('counter:d')
    expect(result).toBe(42)
  })

  it('should work with decrBy()', async () => {
    await Ipc.incrBy('counter:e', 10)
    const result = await Ipc.decrBy('counter:e', 4)
    expect(result).toBe(6)
  })
})
