const fs = require('fs')
const os = require('os')
const Config = require('../../src/Config')

jest.mock('fs')
jest.mock('os')

describe('Config.init()', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    global.__dir = '/mock/project'
    Config.system = undefined
    Config.encrypt.key = 'odac'
  })

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
      if (path === '/mock/project/odac.json') return true
      return false
    })
    fs.readFileSync.mockImplementation(path => {
      if (path === '/mock/project/odac.json') {
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
