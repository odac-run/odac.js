'use strict'

const cluster = require('node:cluster')

/**
 * Tests Ipc hash operations: hset() and hgetall().
 * Why: Validates that hash merge semantics work correctly for Write-Behind Cache
 * update coalescing (last-write-wins per field).
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

describe('Ipc - hset()', () => {
  it('should store and retrieve hash fields', async () => {
    await Ipc.hset('hash:a', {title: 'Hello', views: 100})
    const result = await Ipc.hgetall('hash:a')
    expect(result).toEqual({title: 'Hello', views: 100})
  })

  it('should merge new fields into existing hash', async () => {
    await Ipc.hset('hash:b', {title: 'First'})
    await Ipc.hset('hash:b', {slug: 'first-post'})
    const result = await Ipc.hgetall('hash:b')
    expect(result).toEqual({title: 'First', slug: 'first-post'})
  })

  it('should overwrite existing fields (last-write-wins)', async () => {
    await Ipc.hset('hash:c', {title: 'Old'})
    await Ipc.hset('hash:c', {title: 'New'})
    const result = await Ipc.hgetall('hash:c')
    expect(result).toEqual({title: 'New'})
  })

  it('should return null for non-existent hash', async () => {
    const result = await Ipc.hgetall('hash:nonexistent')
    expect(result).toBeNull()
  })

  it('should be deletable via del()', async () => {
    await Ipc.hset('hash:d', {title: 'Test'})
    await Ipc.del('hash:d')
    const result = await Ipc.hgetall('hash:d')
    expect(result).toBeNull()
  })
})
