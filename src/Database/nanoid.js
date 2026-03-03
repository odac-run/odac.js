'use strict'

const nodeCrypto = require('node:crypto')

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'

/**
 * Generates a cryptographically secure, URL-safe alphanumeric NanoID.
 * Why: Centralized implementation shared by Database.js and Migration.js
 * to avoid code duplication. Uses rejection sampling on crypto.randomBytes
 * for uniform distribution across a 62-character alphabet.
 * @param {number} size - Desired ID length (default: 21)
 * @returns {string} URL-safe alphanumeric ID
 */
function nanoid(size = 21) {
  let id = ''
  while (id.length < size) {
    const bytes = nodeCrypto.randomBytes(size + 5)
    for (let i = 0; i < bytes.length; i++) {
      const byte = bytes[i] & 63
      if (byte < 62) {
        id += ALPHABET[byte]
        if (id.length === size) break
      }
    }
  }
  return id
}

module.exports = nanoid
