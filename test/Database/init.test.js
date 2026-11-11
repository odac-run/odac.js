'use strict'

// Database.init() tests the connection before migrating. A primary that only
// logged the failure started serving with a dead database. The primary boots
// once, so failing there surfaces the misconfiguration at deploy time. A
// worker is respawned during normal operation; knex reconnects per query, so
// a transient outage must not turn into a crash loop.

const mockRaw = jest.fn()
jest.mock('../../src/Database/ConnectionFactory', () => ({
  buildConnections: jest.fn(() => ({default: {raw: (...a) => mockRaw(...a)}}))
}))
jest.mock('../../src/Database/ReadCache', () => ({init: jest.fn()}))
jest.mock('../../src/Database/WriteBuffer', () => ({init: jest.fn(async () => {})}))

const cluster = require('node:cluster')
const {buildConnections} = require('../../src/Database/ConnectionFactory')

describe('Database.init()', () => {
  let DB
  const originalPrimary = cluster.isPrimary

  beforeEach(() => {
    jest.isolateModules(() => {
      DB = require('../../src/Database')
    })
    global.__dir = '/nonexistent-odac-app'
    global.Odac = {Config: {database: {type: 'postgres', database: 'app'}}}
    mockRaw.mockReset()
    jest.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    Object.defineProperty(cluster, 'isPrimary', {value: originalPrimary, configurable: true})
    jest.restoreAllMocks()
    delete global.Odac
    delete global.__dir
  })

  it('fails startup on the primary when a database is unreachable', async () => {
    Object.defineProperty(cluster, 'isPrimary', {value: true, configurable: true})
    mockRaw.mockRejectedValue(new Error('ECONNREFUSED'))

    await expect(DB.init()).rejects.toThrow(/default.*ECONNREFUSED/)
  })

  it('only logs on a worker so a transient outage cannot crash-loop it', async () => {
    Object.defineProperty(cluster, 'isPrimary', {value: false, configurable: true})
    mockRaw.mockRejectedValue(new Error('ECONNREFUSED'))

    await expect(DB.init()).resolves.toBeUndefined()
    expect(console.error).toHaveBeenCalled()
  })

  it('sizes pools for the whole cluster', async () => {
    Object.defineProperty(cluster, 'isPrimary', {value: true, configurable: true})
    mockRaw.mockResolvedValue()

    await DB.init()

    expect(buildConnections).toHaveBeenCalledWith(global.Odac.Config.database, {processCount: expect.any(Number)})
    expect(buildConnections.mock.calls.at(-1)[1].processCount).toBeGreaterThanOrEqual(2)
  })
})
