const Config = require('../../src/Config')

describe('Config._interpolate()', () => {
  it('should replace ${VAR} with environment variables', () => {
    process.env.FOO = 'bar'
    const result = Config._interpolate('hello-${FOO}')
    expect(result).toBe('hello-bar')
  })

  it('should replace ${VAR} when variable name includes hyphen', () => {
    process.env['MY-VAR'] = 'hyphen-value'
    const result = Config._interpolate('hello-${MY-VAR}')
    expect(result).toBe('hello-hyphen-value')
    delete process.env['MY-VAR']
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
