const Odac = require('../src/Odac')

// Mock all dependencies
jest.mock('../src/Storage', () => ({init: jest.fn()}))
jest.mock('../src/Env', () => ({init: jest.fn(), get: jest.fn()}))
jest.mock('../src/Config', () => ({
  init: jest.fn(),
  request: {timeout: 10000},
  lang: {default: 'en'}
}))
jest.mock('../src/Database', () => ({init: jest.fn()}))
jest.mock('../src/Ipc', () => ({init: jest.fn(), subscribe: jest.fn(), unsubscribe: jest.fn()}))
jest.mock('../src/Route', () => {
  return jest.fn().mockImplementation(() => ({
    init: jest.fn(),
    routes: {
      www: {}
    }
  }))
})
jest.mock('../src/Server', () => ({init: jest.fn()}))

describe('Odac', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    global.__dir = '/mock/project'
  })

  describe('init', () => {
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

  describe('instance', () => {
    it('should create a context object without req/res', () => {
      const ctx = Odac.instance('id-123')
      expect(ctx.Config).toBeDefined()
      expect(ctx.Database).toBeDefined()
      expect(ctx.Ipc).toBeDefined()
      expect(ctx.Request).toBeUndefined()
    })

    it('should create a context object with req/res', () => {
      const mockReq = {url: '/', method: 'GET', headers: {host: 'example.com'}, connection: {remoteAddress: '127.0.0.1'}, on: jest.fn()}
      const mockRes = {}
      const ctx = Odac.instance('id-123', mockReq, mockRes)
      expect(ctx.Request).toBeDefined()
      expect(ctx.Auth).toBeDefined()
      expect(ctx.Token).toBeDefined()
      expect(ctx.Lang).toBeDefined()
      expect(ctx.View).toBeDefined()
    })

    it('should provide helper methods on the context', () => {
      const mockReq = {url: '/', method: 'GET', headers: {host: 'example.com'}, connection: {remoteAddress: '127.0.0.1'}, on: jest.fn()}
      const mockRes = {end: jest.fn(), write: jest.fn()}
      const ctx = Odac.instance('id-123', mockReq, mockRes)

      expect(typeof ctx.env).toBe('function')
      expect(typeof ctx.return).toBe('function')
      expect(typeof ctx.write).toBe('function')
    })

    it('should handle Ipc subscription through Proxy', async () => {
      const ctx = Odac.instance('id-123')
      const callback = jest.fn()
      const IpcSingleton = require('../src/Ipc')
      IpcSingleton.subscribe.mockResolvedValue('sub-id')

      await ctx.Ipc.subscribe('test-channel', callback)

      expect(IpcSingleton.subscribe).toHaveBeenCalledWith('test-channel', callback)
      expect(ctx._ipcSubs).toHaveLength(1)
    })
  })
})
