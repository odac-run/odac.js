const nodeCrypto = require('crypto')
const fs = require('fs')
const os = require('os')

module.exports = {
  auth: {
    key: 'id',
    token: 'odac_auth' // This is the TABLE NAME for tokens, not a secret token.
  },
  request: {
    timeout: 10000
  },
  encrypt: {
    key: null // Default is null. MUST be set via config or env.
  },
  earlyHints: {
    enabled: true,
    auto: true,
    maxResources: 5
  },
  ipc: {
    driver: 'memory',
    redis: 'default'
  },
  debug: process.env.NODE_ENV !== 'production',

  init: function () {
    try {
      this.system = JSON.parse(fs.readFileSync(os.homedir() + '/.odac/config.json'))
    } catch {
      this.system = {}
    }

    if (fs.existsSync(__dir + '/config.json')) {
      let config = {}
      try {
        config = JSON.parse(fs.readFileSync(__dir + '/config.json'))
        config = this._interpolate(config)
      } catch (err) {
        console.error(
          JSON.stringify({
            level: 'error',
            message: 'Error reading config file',
            file: __dir + '/config.json',
            error: err.message
          })
        )
      }
      this._deepMerge(this, config)
    }

    // Security Hardening: Ensure encryption key is set
    if (!this.encrypt.key) {
      this.encrypt.key = process.env.ODAC_ENCRYPT_KEY || process.env.APP_KEY
    }

    if (!this.encrypt.key) {
      if (process.env.NODE_ENV === 'production') {
        throw new Error('CRITICAL: Encryption key not found. Set ODAC_ENCRYPT_KEY environment variable.')
      } else {
        // Development mode: Generate a random key
        this.encrypt.key = nodeCrypto.randomBytes(32).toString('hex')
        console.warn(
          JSON.stringify({
            level: 'warn',
            message: 'Encryption key not found. Using generated key for development.'
          })
        )
      }
    }

    this.encrypt.key = nodeCrypto.createHash('sha256').update(this.encrypt.key).digest('hex')
  },

  _interpolate: function (obj) {
    if (typeof obj === 'string') {
      return obj.replace(/\$\{(\w+)\}/g, (_, key) => {
        // Special variables
        if (key === 'odac') {
          return __dirname.replace(/\/src$/, '/client')
        }
        // Environment variables
        return process.env[key] || ''
      })
    }
    if (Array.isArray(obj)) {
      return obj.map(item => this._interpolate(item))
    }
    if (obj && typeof obj === 'object') {
      const result = {}
      for (const key of Object.keys(obj)) {
        result[key] = this._interpolate(obj[key])
      }
      return result
    }
    return obj
  },

  _deepMerge: function (target, source) {
    for (const key of Object.keys(source)) {
      if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
        // Ensure target[key] is also an object before recursive merge
        if (!target[key] || typeof target[key] !== 'object' || Array.isArray(target[key])) {
          target[key] = {}
        }
        this._deepMerge(target[key], source[key])
      } else {
        target[key] = source[key]
      }
    }
  }
}
