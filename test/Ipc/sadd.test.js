'use strict'

const cluster = require('node:cluster')

/**
 * Tests Ipc set operations: sadd(), smembers(), srem().
 * Why: WriteBuffer uses index sets to track active counter/update/queue keys
 * for efficient flush discovery without expensive SCAN operations.
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

describe('Ipc - sadd()', () => {
  it('should add members and return count of new additions', async () => {
    const added = await Ipc.sadd('set:a', 'x', 'y', 'z')
    expect(added).toBe(3)
  })

  it('should not duplicate existing members', async () => {
    await Ipc.sadd('set:b', 'x', 'y')
    const added = await Ipc.sadd('set:b', 'y', 'z')
    expect(added).toBe(1) // Only 'z' is new
  })
})

describe('Ipc - smembers()', () => {
  it('should return all members', async () => {
    await Ipc.sadd('set:c', 'a', 'b', 'c')
    const members = await Ipc.smembers('set:c')
    expect(members.sort()).toEqual(['a', 'b', 'c'])
  })

  it('should return empty array for non-existent set', async () => {
    const result = await Ipc.smembers('set:nonexistent')
    expect(result).toEqual([])
  })
})

describe('Ipc - srem()', () => {
  it('should remove specified members', async () => {
    await Ipc.sadd('set:d', 'a', 'b', 'c')
    const removed = await Ipc.srem('set:d', 'b')
    expect(removed).toBe(1)

    const remaining = await Ipc.smembers('set:d')
    expect(remaining.sort()).toEqual(['a', 'c'])
  })

  it('should return 0 for non-existent members', async () => {
    await Ipc.sadd('set:e', 'x')
    const removed = await Ipc.srem('set:e', 'nonexistent')
    expect(removed).toBe(0)
  })
})
