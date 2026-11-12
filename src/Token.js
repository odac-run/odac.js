const nodeCrypto = require('crypto')

const LEGACY_LIST = '_token'

/**
 * CSRF tokens bound to the session.
 * Why: each token is its own session key (`_token:<hash>`) holding its expiry. A single
 * token list was read, modified and written back, so two workers issuing or consuming
 * tokens for the same session at once overwrote each other's change and a freshly issued
 * token was lost. Expired tokens are evicted by the session GC.
 */
class Token {
  // CLUSTER SAFETY NOTE:
  // This is a request-scoped local cache (debounce) for performance.
  // Valid tokens represent state persisted in Session (LMDB), shared across all workers.
  confirmed = []

  constructor(Request) {
    this.Request = Request
  }

  // - CHECK TOKEN
  check(token) {
    if (typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token)) return false
    if (this.confirmed.includes(token)) return true
    const key = `_token:${token}`
    const expires = this.Request.session(key)
    if (typeof expires === 'number' && expires > Date.now()) {
      this.Request.session(key, null)
      this.confirmed.push(token)
      return true
    }
    // Tokens issued before per-token keys live in a list; it is only drained, never extended.
    const legacy = this.Request.session(LEGACY_LIST)
    if (Array.isArray(legacy) && legacy.includes(token)) {
      const rest = legacy.filter(t => t !== token)
      this.Request.session(LEGACY_LIST, rest.length ? rest : null)
      this.confirmed.push(token)
      return true
    }
    return false
  }

  // - GENERATE TOKEN
  generate() {
    // Enterprise Standard: Use CSPRNG (Cryptographically Secure Pseudo-Random Number Generator)
    const token = nodeCrypto.randomBytes(32).toString('hex')
    const lifetime = global.Odac?.Storage?.sessionLifetime ?? 7 * 24 * 60 * 60 * 1000
    this.Request.session(`_token:${token}`, Date.now() + lifetime)
    return token
  }
}

module.exports = Token
