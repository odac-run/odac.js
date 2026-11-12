'use strict'

const cluster = require('node:cluster')
const {EventEmitter} = require('node:events')

/**
 * Memory driver behaviour on the primary process itself (cron jobs) and towards workers.
 * Why: primary subscriptions never received messages, direct reads handed out the stored
 * object, sets were O(n) arrays, and a send to a disconnecting worker could crash the primary.
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
  jest.restoreAllMocks()
  await Ipc.close()
  delete global.Odac
})

const tick = () => new Promise(resolve => setImmediate(resolve))

describe('Ipc memory driver on the primary', () => {
  it('delivers messages to subscribers on the primary', async () => {
    const received = []
    await Ipc.subscribe('jobs', message => received.push(message))
    await Ipc.publish('jobs', {id: 1})
    await tick()
    expect(received).toEqual([{id: 1}])
  })

  it('stops delivering after unsubscribe', async () => {
    const received = []
    const handle = await Ipc.subscribe('jobs', message => received.push(message))
    await handle.unsubscribe()
    await Ipc.publish('jobs', {id: 2})
    await tick()
    expect(received).toEqual([])
  })

  it('returns copies from direct reads, like a worker gets', async () => {
    const value = {list: [1]}
    await Ipc.set('obj', value)
    value.list.push(2) // caller mutates its own object after storing it
    const read = await Ipc.get('obj')
    read.list.push(3)
    expect(await Ipc.get('obj')).toEqual({list: [1]})
  })

  it('keeps set semantics with constant-time membership', async () => {
    expect(await Ipc.sadd('s', 'a', 'b', 'a')).toBe(2)
    expect(await Ipc.sadd('s', 'b', 'c')).toBe(1)
    expect((await Ipc.smembers('s')).sort()).toEqual(['a', 'b', 'c'])
    expect(await Ipc.srem('s', 'a', 'x')).toBe(1)
    expect((await Ipc.smembers('s')).sort()).toEqual(['b', 'c'])
  })

  it('does not throw when a subscribed worker is disconnecting', async () => {
    const worker = new EventEmitter()
    worker.id = 77
    worker.isConnected = () => true
    // A closed channel reports through the callback; without one Node emits 'error'.
    worker.send = jest.fn((message, callback) => {
      if (typeof callback === 'function') callback(new Error('Channel closed'))
      else worker.emit('error', new Error('Channel closed'))
    })
    cluster.workers = {77: worker}
    jest.spyOn(console, 'error').mockImplementation(() => {})
    global.__odac_ipc_message_handler(worker, {type: 'ipc:subscribe', channel: 'news'})

    await expect(Ipc.publish('news', 'hello')).resolves.toBeUndefined()
    expect(worker.send).toHaveBeenCalledWith({type: 'ipc:message', channel: 'news', message: 'hello'}, expect.any(Function))
    delete cluster.workers
  })

  it('skips workers that are already disconnected', async () => {
    const worker = {id: 78, isConnected: () => false, send: jest.fn()}
    cluster.workers = {78: worker}
    global.__odac_ipc_message_handler(worker, {type: 'ipc:get', id: 'r1', key: 'x'})
    expect(worker.send).not.toHaveBeenCalled()
    delete cluster.workers
  })
})
