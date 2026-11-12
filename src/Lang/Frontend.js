'use strict'

const Extractor = require('./Extractor.js')

// In debug mode the frontend sources are re-scanned at most this often.
const RESCAN_INTERVAL_MS = 2000

/**
 * The translation entries the browser code (`view/js/`) uses.
 * Why: the browser must receive only the translations its own code asks for. Sending the
 * whole dictionary would expose every string of the application (admin screens, internal
 * messages) to every visitor, and letting the browser report missing keys would let anyone
 * write to the language files. The entries are read from the source, the same way
 * `odac lang:sync` reads them: once in production, and again on change in debug mode.
 */
class FrontendKeys {
  #entries = null
  #scannedAt = 0
  #scanning = null

  async #scan(root) {
    try {
      const {entries} = await Extractor.extract(root, {dir: Extractor.FRONTEND_DIR})
      this.#entries = Object.freeze([...entries.values()].map(({key, context}) => Object.freeze({key, context})))
    } catch {
      // Unreadable sources: keep serving what was found before.
      this.#entries ??= Object.freeze([])
    }
    this.#scannedAt = Date.now()
  }

  /**
   * @param {string} root Project directory.
   * @param {boolean} debug Re-scan when stale (the previous result is served meanwhile).
   * @returns {Promise<ReadonlyArray<{key: string, context: string}>>} The same array instance
   *   until a scan finds a change, so callers can cache on it.
   */
  async entries(root, debug) {
    const stale = debug && Date.now() - this.#scannedAt >= RESCAN_INTERVAL_MS
    if ((this.#entries === null || stale) && !this.#scanning) {
      const previous = this.#entries
      this.#scanning = this.#scan(root)
        .then(() => {
          // Keep the old instance when nothing changed, so derived caches stay valid.
          if (previous && same(previous, this.#entries)) this.#entries = previous
        })
        .finally(() => (this.#scanning = null))
    }
    if (this.#entries === null) await this.#scanning
    return this.#entries
  }

  /** Forgets the scan result. Used by tests. */
  reset() {
    this.#entries = null
    this.#scannedAt = 0
    this.#scanning = null
  }
}

function same(a, b) {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i].key !== b[i].key || a[i].context !== b[i].context) return false
  return true
}

module.exports = FrontendKeys
