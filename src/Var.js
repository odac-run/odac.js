const fs = require('fs')
const net = require('net')
const nodeCrypto = require('crypto')

// Hostname labels of 1-63 characters without a leading/trailing hyphen, at most 253 in total,
// ending in an alphabetic TLD of any length or an IDN (punycode) TLD.
const DOMAIN_PATTERN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/i
// Pictographic characters, flag halves and keycaps (1️⃣). A literal range such as
// [\u1F000-\u1F6FF] is parsed as '\u1F00', '0'-'\u1F6F', 'F' and matched almost every letter.
const EMOJI_PATTERN = /\p{Extended_Pictographic}|\p{Regional_Indicator}|[0-9#*]\uFE0F?\u20E3/u
const URL_SCHEMES = new Set(['http:', 'https:', 'ftp:', 'ftps:', 'ws:', 'wss:'])

// Absolute URL with an authority. The scheme allowlist keeps javascript:/data: out, and the
// explicit '//' check stops the WHATWG parser from accepting 'http:example.com'.
function isUrl(value) {
  const text = String(value)
  if (/\s/.test(text) || !/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return false
  try {
    const url = new URL(text)
    return URL_SCHEMES.has(url.protocol) && url.hostname !== ''
  } catch {
    return false
  }
}

const DEFAULT_ENCRYPT_KEY = 'odac'
// Config.init() replaces the configured key with its SHA-256 digest, so the default key
// must also be recognised in that form or the production guard below never fires.
const DEFAULT_ENCRYPT_KEY_DIGEST = nodeCrypto.createHash('sha256').update(DEFAULT_ENCRYPT_KEY).digest()
const LEGACY_IV = '2dea8a25e5e8f004'
// Ciphertext prefixes. Bare base64 is the legacy fixed-IV CBC format, `v2:` is random-IV CBC,
// `v3:` is AES-256-GCM. Only v3 is produced; the older formats are kept for decryption so
// existing data stays readable.
const CBC_PREFIX = 'v2:'
const GCM_PREFIX = 'v3:'
const GCM_IV_LENGTH = 12
const GCM_TAG_LENGTH = 16
const GCM_KEY_INFO = 'odac:var:encrypt:v3'

function isDefaultKey(key) {
  if (Buffer.isBuffer(key)) return key.equals(DEFAULT_ENCRYPT_KEY_DIGEST)
  return key === DEFAULT_ENCRYPT_KEY
}

// Resolves the encryption secret, refusing the well-known default key in
// production so deterministic/guessable ciphertext never ships live.
function resolveEncryptKey(key) {
  key = key || Odac.Config.encrypt.key
  if (isDefaultKey(key)) {
    if (!Odac.Config.debug) {
      throw new Error('Var.encrypt: refusing to use the default encryption key in production. Set config.encrypt.key to a strong secret.')
    }
    console.warn('Var.encrypt: using the default encryption key — override config.encrypt.key before deploying.')
  }
  return key
}

// v2 key derivation. String() turns a Buffer key into lossy UTF-8, so it is only kept
// to decrypt data written in the v2 format.
function deriveCbcKey(key) {
  return nodeCrypto.createHash('sha256').update(String(key)).digest()
}

// v3 key derivation: HKDF over the raw key bytes (Buffer keys are used as-is, strings as UTF-8),
// with a purpose label so the derived key is never reused by another primitive.
function deriveGcmKey(key) {
  const material = Buffer.isBuffer(key) ? key : Buffer.from(String(key))
  return Buffer.from(nodeCrypto.hkdfSync('sha256', material, Buffer.alloc(0), GCM_KEY_INFO, 32))
}

function decryptGcm(payload, secret) {
  const raw = Buffer.from(payload, 'base64')
  if (raw.length < GCM_IV_LENGTH + GCM_TAG_LENGTH) return null
  const iv = raw.subarray(0, GCM_IV_LENGTH)
  const tag = raw.subarray(GCM_IV_LENGTH, GCM_IV_LENGTH + GCM_TAG_LENGTH)
  const decipher = nodeCrypto.createDecipheriv('aes-256-gcm', deriveGcmKey(secret), iv, {authTagLength: GCM_TAG_LENGTH})
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(raw.subarray(GCM_IV_LENGTH + GCM_TAG_LENGTH)), decipher.final()]).toString()
}

class Var {
  #value = null
  #any = false

  constructor(value) {
    this.#value = value
  }

  clear(...args) {
    args = this.#parse(args)
    let str = this.#value
    // Remove each argument as a LITERAL substring. Building a RegExp from raw
    // input crashes on invalid patterns (e.g. '[') and is a ReDoS vector.
    for (const arg of args) str = str.replaceAll(arg, '')
    return str
  }

  contains(...args) {
    args = this.#parse(args)
    let any = this.#any
    this.#any = false
    let result = !any
    for (const key of args) {
      if (any) result = result || this.#value.includes(key)
      else result = result && this.#value.includes(key)
    }
    return result
  }

  containsAny(...args) {
    args = this.#parse(args)
    this.#any = true
    return this.contains(args)
  }

  date(format) {
    if (!format) format = 'Y-m-d H:i:s'
    let date = new Date(this.#value)
    let year = date.getFullYear()
    let month = date.getMonth() + 1
    let day = date.getDate()
    let hour = date.getHours()
    let minute = date.getMinutes()
    let second = date.getSeconds()
    return Odac.Var(format).replace({
      Y: year,
      m: month < 10 ? `0${month}` : month,
      d: day < 10 ? `0${day}` : day,
      H: hour < 10 ? `0${hour}` : hour,
      i: minute < 10 ? `0${minute}` : minute,
      s: second < 10 ? `0${second}` : second,
      y: year.toString().substr(2, 2)
    })
  }

  /**
   * Decrypts a value produced by encrypt().
   * Why: application data encrypted by any ODAC version must remain readable, so the legacy
   * CBC formats are still accepted here even though encrypt() only writes authenticated v3.
   * @param {string|Buffer} [key] Overrides Odac.Config.encrypt.key.
   * @returns {string|null} Plaintext, or null when the ciphertext is malformed, tampered or uses another key.
   */
  decrypt(key) {
    const secret = resolveEncryptKey(key)
    const value = this.#value
    try {
      if (typeof value !== 'string') return null
      if (value.startsWith(GCM_PREFIX)) return decryptGcm(value.slice(GCM_PREFIX.length), secret)
      if (value.startsWith(CBC_PREFIX)) {
        // v2: first 16 bytes are the IV, rest is ciphertext.
        const raw = Buffer.from(value.slice(CBC_PREFIX.length), 'base64')
        const decipher = nodeCrypto.createDecipheriv('aes-256-cbc', deriveCbcKey(secret), raw.subarray(0, 16))
        return Buffer.concat([decipher.update(raw.subarray(16)), decipher.final()]).toString()
      }
      // Legacy fixed-IV format (raw 32-byte key).
      const decipher = nodeCrypto.createDecipheriv('aes-256-cbc', secret, LEGACY_IV)
      return Buffer.concat([decipher.update(Buffer.from(value, 'base64')), decipher.final()]).toString()
    } catch {
      return null
    }
  }

  /**
   * Encrypts the value with AES-256-GCM under a fresh random IV.
   * Why: GCM authenticates the ciphertext, so a modified value fails to decrypt instead of
   * yielding attacker-influenced plaintext or leaking a padding oracle.
   * @param {string|Buffer} [key] Overrides Odac.Config.encrypt.key.
   * @returns {string} `v3:` + base64(iv | tag | ciphertext)
   */
  encrypt(key) {
    const secret = resolveEncryptKey(key)
    const iv = nodeCrypto.randomBytes(GCM_IV_LENGTH)
    const cipher = nodeCrypto.createCipheriv('aes-256-gcm', deriveGcmKey(secret), iv, {authTagLength: GCM_TAG_LENGTH})
    const encrypted = Buffer.concat([cipher.update(this.#value), cipher.final()])
    return GCM_PREFIX + Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64')
  }

  hash() {
    const salt = nodeCrypto.randomBytes(16).toString('hex')
    const derivedKey = nodeCrypto.scryptSync(this.#value, salt, 64)
    return `$scrypt$${salt}$${derivedKey.toString('hex')}`
  }

  hashCheck(check) {
    if (!this.#value.startsWith('$scrypt$')) return false
    const parts = this.#value.split('$')
    if (parts.length < 4) return false

    const salt = parts[2]
    const originalHash = Buffer.from(parts[3], 'hex')

    const derivedKey = nodeCrypto.scryptSync(check, salt, 64)
    return nodeCrypto.timingSafeEqual(originalHash, derivedKey)
  }

  html() {
    if (this.#value === null || this.#value === undefined) return ''
    const map = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    }
    return String(this.#value).replace(/[&<>"']/g, m => map[m])
  }

  is(...args) {
    args = this.#parse(args)
    let any = this.#any
    this.#any = false
    let result = !any
    //     if(\Odac::config('locale')->get() == 'tr') $this->str = \Odac::var($this->str)->clear('Ç','ç','Ğ','ğ','İ','ı','Ö','ö','Ş','ş','Ü','ü');
    if (args.includes('alpha')) result = (result || any) && ((any && result) || /^[A-Za-z]+$/.test(this.#value))
    if (args.includes('alphaspace')) result = (result || any) && ((any && result) || /^[A-Za-z\s]+$/.test(this.#value))
    if (args.includes('alphanumeric')) result = (result || any) && ((any && result) || /^[A-Za-z0-9]+$/.test(this.#value))
    if (args.includes('alphanumericspace')) result = (result || any) && ((any && result) || /^[A-Za-z0-9\s]+$/.test(this.#value))
    if (args.includes('hash')) result = (result || any) && ((any && result) || /^\$scrypt\$[a-f0-9]+\$[a-f0-9]+$/.test(this.#value))
    if (args.includes('date')) result = (result || any) && ((any && result) || !isNaN(Date.parse(this.#value)))
    if (args.includes('domain')) result = (result || any) && ((any && result) || DOMAIN_PATTERN.test(this.#value))
    if (args.includes('email'))
      result = (result || any) && ((any && result) || /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(this.#value))
    if (args.includes('float')) result = (result || any) && ((any && result) || !isNaN(parseFloat(this.#value)))
    if (args.includes('host')) result = (result || any) && ((any && result) || net.isIPv4(String(this.#value)))
    if (args.includes('ip')) result = (result || any) && ((any && result) || net.isIP(String(this.#value)) !== 0)
    if (args.includes('json')) {
      // Never let a malformed value throw out of a validity check; also fixes the
      // old `.length >= 0` test that wrongly rejected valid JSON objects.
      let isJson = false
      try {
        JSON.parse(this.#value)
        isJson = true
      } catch {
        isJson = false
      }
      result = (result || any) && ((any && result) || isJson)
    }
    if (args.includes('mac')) result = (result || any) && ((any && result) || /^([0-9A-Fa-f]{2}[:-]){5}([0-9A-Fa-f]{2})$/.test(this.#value))
    if (args.includes('md5')) result = (result || any) && ((any && result) || /^[a-f0-9A-F]{32}$/.test(this.#value))
    if (args.includes('numeric')) result = (result || any) && ((any && result) || !isNaN(this.#value))
    if (args.includes('url')) result = (result || any) && ((any && result) || isUrl(this.#value))
    if (args.includes('emoji')) result = (result || any) && ((any && result) || EMOJI_PATTERN.test(this.#value))
    if (args.includes('username')) result = (result || any) && ((any && result) || /^[a-zA-Z0-9]+$/.test(this.#value))
    if (args.includes('xss')) result = (result || any) && ((any && result) || this.#value == this.#value.replace(/<[^>]*>/g, ''))
    return result
  }

  isAny(...args) {
    args = this.#parse(args)
    this.#any = true
    return this.is(args)
  }

  isBegin(...args) {
    args = this.#parse(args)
    for (const arg of args) if (this.#value.startsWith(arg)) return true
    return false
  }

  isEnd(...args) {
    args = this.#parse(args)
    for (const arg of args) if (this.#value.endsWith(arg)) return true
    return false
  }

  md5() {
    return nodeCrypto.createHash('md5').update(this.#value).digest('hex')
  }

  #parse(value) {
    if (!['array', 'object'].includes(typeof value)) return [value]
    if (value.length == 1 && Array.isArray(value[0])) return value[0]
    return value
  }

  replace(...args) {
    args = this.#parse(args)
    if (args.length == 1) args = args[0]
    if (['array', 'object'].includes(typeof this.#value)) {
      let new_value = {}
      for (const key of Object.keys(this.#value)) new_value[key] = Odac.Var(this.#value[key]).replace(args)
      return new_value
    }
    for (const arg of Object.keys(args)) this.#value = this.#value.replace(arg, args[arg])
    return this.#value
  }

  save(path) {
    // Create parent directories based on the TARGET path, not the content being
    // written. `recursive` handles nested and absolute paths and is a no-op when
    // the directory already exists.
    const dir = path.substring(0, path.lastIndexOf('/'))
    if (dir) fs.mkdirSync(dir, {recursive: true})
    return fs.writeFileSync(path, this.#value)
  }

  slug(separator = '-') {
    let str = this.#value
    str = str.replace(/[^a-zA-Z0-9\s]/g, separator)
    str = str.replace(/[\s]/g, separator)
    str = str.replace(/[-]+/g, separator)
    str = str.toLowerCase()
    return str
  }

  format(format) {
    let str = this.#value
    let result = ''
    let letter = 0
    for (let i = 0; i < format.length; i++) {
      if (format[i] == '?') {
        result += str[letter]
        letter++
      } else if (format[i] == '*') {
        result += str.substr(letter)
        letter += str.substr(letter).length
      } else {
        result += format[i]
      }
    }
    return result
  }
}

module.exports = Var
