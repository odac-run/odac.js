const fs = require('fs')
const os = require('os')
const path = require('path')
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
  it('produces authenticated v3 ciphertext that rejects tampering', () => {
    setKey('a-strong-secret-key')
    const cipher = new Var('payload').encrypt()
    expect(cipher.startsWith('v3:')).toBe(true)

    const raw = Buffer.from(cipher.slice(3), 'base64')
    raw[raw.length - 1] ^= 0x01
    expect(new Var('v3:' + raw.toString('base64')).decrypt()).toBeNull()
  })

  it('does not decrypt with a different key', () => {
    setKey('first-secret')
    const cipher = new Var('payload').encrypt()
    expect(new Var(cipher).decrypt('second-secret')).toBeNull()
  })

  it('keeps Buffer keys distinct even when their UTF-8 forms collide', () => {
    // Both decode to 32 U+FFFD characters; the v2 derivation treated them as the same key.
    const keyA = Buffer.alloc(32, 0x80)
    const keyB = Buffer.alloc(32, 0x81)
    expect(String(keyA)).toBe(String(keyB))

    setKey(keyA)
    const cipher = new Var('payload').encrypt()
    expect(new Var(cipher).decrypt(keyA)).toBe('payload')
    expect(new Var(cipher).decrypt(keyB)).toBeNull()
  })

  describe('with keys prepared by Config.init()', () => {
    let tmpDir
    let Config

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'odac-var-encrypt-'))
      global.__dir = tmpDir
      jest.isolateModules(() => {
        Config = require('../../src/Config')
      })
      global.Odac = {Config}
    })

    afterEach(() => {
      delete global.__dir
      fs.rmSync(tmpDir, {recursive: true, force: true})
    })

    it('refuses the default key in production after Config.init() hashed it', () => {
      Config.init()
      Config.debug = false
      expect(Buffer.isBuffer(Config.encrypt.key)).toBe(true)
      expect(() => new Var('x').encrypt()).toThrow(/default encryption key/)
      expect(() => new Var('x').decrypt()).toThrow(/default encryption key/)
    })

    it('encrypts and decrypts with a configured key in production', () => {
      fs.writeFileSync(path.join(tmpDir, 'odac.json'), JSON.stringify({encrypt: {key: 'production-secret'}}))
      Config.init()
      Config.debug = false
      const cipher = new Var('card').encrypt()
      expect(new Var(cipher).decrypt()).toBe('card')
    })
  })
})
