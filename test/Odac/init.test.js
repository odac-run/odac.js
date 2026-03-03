const Odac = require('../../src/Odac')

// Mock all dependencies
jest.mock('../../src/Storage', () => ({init: jest.fn()}))
jest.mock('../../src/Env', () => ({init: jest.fn(), get: jest.fn()}))
jest.mock('../../src/Config', () => ({
  init: jest.fn(),
  request: {timeout: 10000},
  lang: {default: 'en'}
}))
jest.mock('../../src/Database', () => ({init: jest.fn()}))
jest.mock('../../src/Ipc', () => ({init: jest.fn(), subscribe: jest.fn(), unsubscribe: jest.fn()}))
jest.mock('../../src/Route', () => {
  return jest.fn().mockImplementation(() => ({
    init: jest.fn(),
    routes: {
      www: {}
    }
  }))
})
jest.mock('../../src/Server', () => ({init: jest.fn()}))

describe('Odac.init()', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    global.__dir = '/mock/project'
    delete global.Odac
  })

  it('should initialize all components and set global.Odac', async () => {
    await Odac.init()
    expect(global.Odac).toBeDefined()
    expect(global.Odac.Storage).toBeDefined()
    expect(global.Odac.Config).toBeDefined()
    expect(global.Odac.Env).toBeDefined()
    expect(global.Odac.Database).toBeDefined()
    expect(global.Odac.Ipc).toBeDefined()
    expect(global.Odac.Route).toBeDefined()
    expect(global.Odac.Server).toBeDefined()
    expect(typeof global.__).toBe('function')
  })
})
