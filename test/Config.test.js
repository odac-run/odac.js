const fs = require('fs')
const os = require('os')
const nodeCrypto = require('crypto')
const Config = require('../src/Config')

jest.mock('fs')
jest.mock('os')

describe('Config', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    // Reset global.__dir which is used in Config.js
    global.__dir = '/mock/project'

    // Reset Config properties to defaults before each test
    Config.system = undefined
    Config.encrypt.key = 'odac'
  })

  describe('init', () => {
    it('should load system config from home directory', () => {
      os.homedir.mockReturnValue('/home/user')
      fs.readFileSync.mockImplementation(path => {
        if (path === '/home/user/.odac/config.json') {
          return JSON.stringify({deviceId: '123'})
        }
        return '{}'
      })
      fs.existsSync.mockReturnValue(false)

      Config.init()

      expect(Config.system).toEqual({deviceId: '123'})
      expect(fs.readFileSync).toHaveBeenCalledWith('/home/user/.odac/config.json')
    })

    it('should load project config and merge it', () => {
      os.homedir.mockReturnValue('/home/user')
      fs.existsSync.mockImplementation(path => {
        if (path === '/mock/project/config.json') return true
        return false
      })
      fs.readFileSync.mockImplementation(path => {
        if (path === '/mock/project/config.json') {
          return JSON.stringify({encrypt: {key: 'secret'}})
        }
        return '{}'
      })

      Config.init()

      // The key gets hashed in init(), so it won't be 'secret' anymore
      expect(Config.encrypt.key).not.toBe('secret')
      expect(Config.encrypt.key).toBeInstanceOf(Buffer)
    })

    it('should interpolate variables in config', () => {
      process.env.TEST_VAR = 'env_value'
      os.homedir.mockReturnValue('/home/user')
      fs.existsSync.mockReturnValue(true)
      fs.readFileSync.mockReturnValue(
        JSON.stringify({
          custom: 'value-${TEST_VAR}'
        })
      )

      Config.init()

      expect(Config.custom).toBe('value-env_value')
    })
  })

  describe('_interpolate', () => {
    it('should replace ${VAR} with environment variables', () => {
      process.env.FOO = 'bar'
      const result = Config._interpolate('hello-${FOO}')
      expect(result).toBe('hello-bar')
    })

    it('should replace ${odac} with client path', () => {
      // __dirname in Config.js is /.../src, so it replaces /src with /client
      const result = Config._interpolate('path-${odac}')
      expect(result).toMatch(/\/client$/)
    })

    it('should handle nested objects and arrays', () => {
      process.env.VAR = 'x'
      const obj = {
        a: ['${VAR}'],
        b: {c: '${VAR}'}
      }
      const result = Config._interpolate(obj)
      expect(result).toEqual({
        a: ['x'],
        b: {c: 'x'}
      })
    })
  })

  describe('_deepMerge', () => {
    it('should merge objects deeply', () => {
      const target = {a: {b: 1}, c: 2}
      const source = {a: {d: 3}, e: 4}
      Config._deepMerge(target, source)
      expect(target).toEqual({
        a: {b: 1, d: 3},
        c: 2,
        e: 4
      })
    })
  })
})
