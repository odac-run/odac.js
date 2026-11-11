'use strict'

const cluster = require('node:cluster')

// Past maxQueueLength the insert queue must stop growing without dropping rows: inserts go
// straight to the database, and a failing database surfaces as a rejected insert.

let db
let writeBuffer

const queued = table => Odac.Ipc.lrange(`wb:q:default:${table}`, 0, -1)

const setup = async buffer => {
  jest.resetModules()
  db = require('knex')({client: 'sqlite3', connection: {filename: ':memory:'}, useNullAsDefault: true})
  await db.schema.createTable('events', t => {
    t.increments('id')
    t.string('name')
  })

  Object.defineProperty(cluster, 'isPrimary', {value: true, configurable: true})
  const Ipc = require('../../../src/Ipc')
  global.Odac = {
    Config: {buffer: {flushInterval: 999999, checkpointInterval: 999999, maxQueueSize: 1000, ...buffer}},
    Storage: {isReady: () => false, putSync: jest.fn(), removeSync: jest.fn(), getRange: () => []},
    Ipc
  }
  await Ipc.init()
  writeBuffer = require('../../../src/Database/WriteBuffer')
  await writeBuffer.init({default: db})
}

beforeEach(() => {
  jest.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(async () => {
  await writeBuffer.close()
  await Odac.Ipc.close()
  await db.destroy()
  delete global.Odac
  jest.restoreAllMocks()
})

describe('WriteBuffer maxQueueLength', () => {
  it('defaults to ten times maxQueueSize', async () => {
    await setup({maxQueueSize: 50})
    expect(writeBuffer._config.maxQueueLength).toBe(500)
  })

  it('inserts directly once the queue is full', async () => {
    await setup({maxQueueLength: 3})

    for (let i = 0; i < 5; i++) await writeBuffer.insert('default', 'events', {name: `e${i}`})

    expect(await queued('events')).toHaveLength(3)
    expect((await db('events').select('name')).map(r => r.name)).toEqual(['e3', 'e4'])
  })

  it('rejects instead of growing the queue while the database fails', async () => {
    await setup({maxQueueLength: 2})

    await writeBuffer.insert('default', 'ghost', {name: 'a'})
    await writeBuffer.insert('default', 'ghost', {name: 'b'})
    await expect(writeBuffer.insert('default', 'ghost', {name: 'c'})).rejects.toThrow(/queue for ghost is full/)
    await expect(writeBuffer.insert('default', 'ghost', {name: 'd'})).rejects.toThrow(/direct insert failed/)

    expect(await queued('ghost')).toHaveLength(2)
  })

  it('returns to buffering once the queue has drained', async () => {
    await setup({maxQueueLength: 2})
    await writeBuffer.insert('default', 'events', {name: 'a'})
    await writeBuffer.insert('default', 'events', {name: 'b'})

    await writeBuffer.insert('default', 'events', {name: 'direct'})
    await writeBuffer.flush()
    await writeBuffer.insert('default', 'events', {name: 'queued'})

    expect((await db('events').select('name')).map(r => r.name)).toEqual(['direct', 'a', 'b'])
    expect(await queued('events')).toEqual([{name: 'queued'}])
  })

  it('never caps the queue when maxQueueLength is 0', async () => {
    await setup({maxQueueLength: 0, maxQueueSize: 1000})

    for (let i = 0; i < 20; i++) await writeBuffer.insert('default', 'events', {name: `e${i}`})

    expect(await queued('events')).toHaveLength(20)
    expect(await db('events').count({n: '*'})).toEqual([{n: 0}])
  })
})
