const nodeCrypto = require('crypto')
const Var = require('../../src/Var')

// decrypt() must handle the new random-IV format and still decode legacy
// fixed-IV ciphertext for backward compatibility — see IMPROVEMENT-PLAN 2.1.

const LEGACY_IV = '2dea8a25e5e8f004'

// Reproduces the old fixed-IV encryption (raw 32-byte key) to prove pre-migration
// data still decrypts.
function legacyEncrypt(plaintext, key) {
  const cipher = nodeCrypto.createCipheriv('aes-256-cbc', key, LEGACY_IV)
  return Buffer.concat([cipher.update(plaintext), cipher.final()]).toString('base64')
}

describe('Var.decrypt()', () => {
  afterEach(() => {
    delete global.Odac
    jest.restoreAllMocks()
  })

  function setKey(key, debug = true) {
    global.Odac = {Config: {encrypt: {key}, debug}}
  }

  it('decrypts legacy fixed-IV ciphertext (raw 32-byte key)', () => {
    const rawKey = 'a'.repeat(32) // exactly 32 bytes, as legacy required
    setKey(rawKey)
    const legacy = legacyEncrypt('legacy secret', rawKey)
    expect(new Var(legacy).decrypt()).toBe('legacy secret')
  })

  it('returns null on corrupt input instead of throwing', () => {
    setKey('a-strong-secret-key')
    expect(new Var('not-valid-base64-!!!').decrypt()).toBeNull()
  })

  it('decrypts what the current encrypt() produces', () => {
    setKey('another-strong-secret')
    const cipher = new Var('round trip').encrypt()
    expect(new Var(cipher).decrypt()).toBe('round trip')
  })
})
