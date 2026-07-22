const Var = require('../../src/Var')

// encrypt() must use a fresh random IV per call and refuse the default key in
// production — see IMPROVEMENT-PLAN 2.1.

describe('Var.encrypt()', () => {
  afterEach(() => {
    delete global.Odac
    jest.restoreAllMocks()
  })

  function setKey(key, debug = true) {
    global.Odac = {Config: {encrypt: {key}, debug}}
  }

  it('produces different ciphertext for identical plaintext (random IV)', () => {
    setKey('a-strong-secret-key')
    const a = new Var('hello world').encrypt()
    const b = new Var('hello world').encrypt()
    expect(a).not.toBe(b)
  })

  it('round-trips through decrypt()', () => {
    setKey('a-strong-secret-key')
    const cipher = new Var('sensitive data').encrypt()
    expect(new Var(cipher).decrypt()).toBe('sensitive data')
  })

  it('works with an arbitrary-length key (derived to 32 bytes)', () => {
    setKey('short')
    const cipher = new Var('payload').encrypt()
    expect(new Var(cipher).decrypt()).toBe('payload')
  })

  it('refuses the default key in production', () => {
    setKey('odac', false)
    expect(() => new Var('x').encrypt()).toThrow(/default encryption key/)
  })

  it('warns but works with the default key in debug', () => {
    setKey('odac', true)
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
    const cipher = new Var('x').encrypt()
    expect(warn).toHaveBeenCalled()
    expect(new Var(cipher).decrypt()).toBe('x')
  })
})
