'use strict'

const cluster = require('node:cluster')

/**
 * Tests Ipc list operations: rpush() and lrange().
 * Why: Validates that batch insert queue (Write-Behind Cache) correctly appends
 * items and retrieves them in order.
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

describe('Ipc - rpush()', () => {
  it('should append items and return new length', async () => {
    const len1 = await Ipc.rpush('list:a', {action: 'view'})
    const len2 = await Ipc.rpush('list:a', {action: 'click'})
    expect(len1).toBe(1)
    expect(len2).toBe(2)
  })

  it('should append multiple items at once', async () => {
    const len = await Ipc.rpush('list:b', {a: 1}, {a: 2}, {a: 3})
    expect(len).toBe(3)
  })
})

describe('Ipc - lrange()', () => {
  it('should return all items with 0, -1', async () => {
    await Ipc.rpush('list:c', 'first')
    await Ipc.rpush('list:c', 'second')
    await Ipc.rpush('list:c', 'third')

    const result = await Ipc.lrange('list:c', 0, -1)
    expect(result).toEqual(['first', 'second', 'third'])
  })

  it('should return a range of items', async () => {
    await Ipc.rpush('list:d', 'a', 'b', 'c', 'd')
    const result = await Ipc.lrange('list:d', 1, 2)
    expect(result).toEqual(['b', 'c'])
  })

  it('should return empty array for non-existent list', async () => {
    const result = await Ipc.lrange('list:nonexistent', 0, -1)
    expect(result).toEqual([])
  })

  it('should clear list on del()', async () => {
    await Ipc.rpush('list:e', 'item')
    await Ipc.del('list:e')
    const result = await Ipc.lrange('list:e', 0, -1)
    expect(result).toEqual([])
  })
})
