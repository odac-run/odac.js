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

describe('Config._interpolate() edge cases', () => {
  it('drops __proto__ keys instead of changing the prototype of the result', () => {
    const result = Config._interpolate(JSON.parse('{"__proto__": {"x": 1}, "a": 1}'))
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype)
    expect(result.x).toBeUndefined()
    expect(result.a).toBe(1)
  })

  it('warns once for an unset variable and keeps an empty string', () => {
    const spy = jest.spyOn(console, 'warn').mockImplementation(() => {})
    delete process.env.ODAC_UNSET_TEST
    expect(Config._interpolate('a${ODAC_UNSET_TEST}b')).toBe('ab')
    expect(Config._interpolate('${ODAC_UNSET_TEST}')).toBe('')
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy.mock.calls[0][0]).toContain('ODAC_UNSET_TEST')
    spy.mockRestore()
  })

  it('keeps a variable that is set to an empty string without warning', () => {
    const spy = jest.spyOn(console, 'warn').mockImplementation(() => {})
    process.env.ODAC_EMPTY_TEST = ''
    expect(Config._interpolate('${ODAC_EMPTY_TEST}')).toBe('')
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
    delete process.env.ODAC_EMPTY_TEST
  })
})
