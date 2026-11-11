'use strict'

// incrBy on the redis driver: a ttl must be applied once, when the counter is created.

const mockClient = {
  connect: jest.fn().mockResolvedValue(undefined),
  duplicate: jest.fn(() => ({connect: jest.fn().mockResolvedValue(undefined), quit: jest.fn().mockResolvedValue(undefined)})),
  expire: jest.fn().mockResolvedValue(1),
  incrByFloat: jest.fn(),
  quit: jest.fn().mockResolvedValue(undefined)
}

jest.mock('redis', () => ({createClient: jest.fn(() => mockClient)}), {virtual: true})

let Ipc

beforeEach(async () => {
  jest.clearAllMocks()
  jest.resetModules()
  Ipc = require('../../src/Ipc')
  global.Odac = {Config: {ipc: {driver: 'redis'}}}
  await Ipc.init()
})

afterEach(async () => {
  await Ipc.close()
  delete global.Odac
})

describe('Ipc redis - incrBy()', () => {
  it('sets the expiry when the increment creates the counter', async () => {
    mockClient.incrByFloat.mockResolvedValue('1')
    await expect(Ipc.incrBy('rate', 1, 60)).resolves.toBe(1)
    expect(mockClient.expire).toHaveBeenCalledWith('rate', 60)
  })

  it('does not extend the expiry on later increments', async () => {
    mockClient.incrByFloat.mockResolvedValue('3')
    await Ipc.incrBy('rate', 1, 60)
    expect(mockClient.expire).not.toHaveBeenCalled()
  })

  it('never sets an expiry without a ttl', async () => {
    mockClient.incrByFloat.mockResolvedValue('1')
    await Ipc.incrBy('counter', 1)
    expect(mockClient.expire).not.toHaveBeenCalled()
  })
})
