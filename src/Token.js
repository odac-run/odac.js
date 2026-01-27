const nodeCrypto = require('crypto')

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
    let tokens = this.Request.session('_token') || []
    if (this.confirmed.includes(token)) return true
    if (tokens.includes(token)) {
      tokens = tokens.filter(t => t !== token)
      this.Request.session('_token', tokens)
      this.confirmed.push(token)
      return true
    }
    return false
  }

  // - GENERATE TOKEN
  generate() {
    // Enterprise Standard: Use CSPRNG (Cryptographically Secure Pseudo-Random Number Generator)
    // Replaced weak MD5(Math.random) with randomBytes(32)
    let token = nodeCrypto.randomBytes(32).toString('hex')
    let tokens = this.Request.session('_token') || []
    tokens.push(token)
    if (tokens.length > 50) tokens = tokens.slice(-50)
    this.Request.session('_token', tokens)
    return token
  }
}

module.exports = Token
