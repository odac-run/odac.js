const fs = require('fs')
const path = require('path')

// Form records (see View/Form.js) live under a session as sub-keys named
// `_<type>_form_<token>` and carry their own short `expires` timestamp. Evict
// them the instant they lapse rather than waiting for the whole parent session
// to reach the 7-day window — otherwise every unused form render lingers for
// days. Scoped to `_form_` keys so ordinary session values (even ones that
// happen to hold an `expires` field) are never touched.
function isExpiredFormRecord(key, value, now) {
  return (
    typeof key === 'string' &&
    key.includes('_form_') &&
    value !== null &&
    typeof value === 'object' &&
    typeof value.expires === 'number' &&
    now > value.expires
  )
}

// CSRF tokens (Token.js) are session sub-keys `_token:<hash>` whose value is their expiry.
function isExpiredToken(key, value, now) {
  return typeof key === 'string' && key.includes(':_token:') && typeof value === 'number' && now > value
}

// A session expires a lifetime after its last activity (`_active`, written by Request at most
// once per touch interval), or after its creation when it was never touched again.
function sessionExpired(db, key, created, now, expirationMs) {
  if (now - created <= expirationMs) return false
  const active = db.get(key.slice(0, -'_created'.length) + '_active')
  return typeof active !== 'number' || now - active > expirationMs
}

const SESSION_LIFETIME = 7 * 24 * 60 * 60 * 1000
// Keys the session GC reads before yielding to the event loop.
const GC_BATCH_SIZE = 1000

// Marks a queued remove in the pending-writes map.
const REMOVED = Symbol('removed')

class OdacStorage {
  // Writes queued with LMDB but not yet committed: key -> {value}. get() serves them so a
  // request reads its own writes; once committed, LMDB is the source for every process.
  #pending = new Map()
  #gcRunning = false

  constructor() {
    this.db = null
    this.ready = false
    this.gcInterval = null
    // How long a session lives after its last activity. Request uses it for the cookie expiry
    // and the GC for eviction.
    this.sessionLifetime = SESSION_LIFETIME
  }

  init() {
    const {open} = require('lmdb')

    const storagePath = path.join(global.__dir, 'storage')
    const dbPath = path.join(storagePath, 'sessions.db')

    try {
      // Ensure storage directory exists
      if (!fs.existsSync(storagePath)) {
        fs.mkdirSync(storagePath, {recursive: true})
      }

      this.db = open({
        path: dbPath,
        compression: true
        // CLUSTER SAFETY NOTE:
        // LMDB uses memory-mapped files with OS-level locking logic.
        // Multiple workers can safely read/write to this DB simultaneously.
        // Data committed by Worker A is immediately visible to Worker B.
      })
      this.ready = true
    } catch (error) {
      console.error('\x1b[31m[Storage Error]\x1b[0m Failed to initialize LMDB:', error.message)
      console.error('\x1b[33m[Storage]\x1b[0m Path:', dbPath)
      this.ready = false
    }
  }

  // --- Basic KV Operations ---

  get(key) {
    if (!this.ready) return null
    const pending = this.#pending.get(key)
    if (pending) return pending.value === REMOVED ? null : pending.value
    return this.db.get(key) ?? null
  }

  /**
   * Queues a write; it is committed asynchronously together with every other write of the
   * same event-loop turn.
   * Why: sessions, form records and CSRF tokens are written on the request path. A
   * synchronous put opens and commits its own transaction per call, blocking the event loop
   * for the disk commit several times per page view.
   * @returns {boolean}
   */
  put(key, value) {
    if (!this.ready) return false
    this.#queue(key, value, this.db.put(key, value))
    return true
  }

  /** Asynchronous remove; see put(). */
  remove(key) {
    if (!this.ready) return false
    this.#queue(key, REMOVED, this.db.remove(key))
    return true
  }

  /**
   * Synchronous put, committed before returning.
   * Why: for callers that read back through getRange()/getKeys(), which only see committed
   * data (e.g. the write-buffer checkpoint).
   */
  putSync(key, value) {
    if (!this.ready) return false
    this.#pending.delete(key)
    this.db.putSync(key, value)
    return true
  }

  /** Synchronous remove; see putSync(). */
  removeSync(key) {
    if (!this.ready) return false
    this.#pending.delete(key)
    this.db.removeSync(key)
    return true
  }

  /**
   * Runs synchronous puts/removes in one committed transaction.
   * Why: a checkpoint writes many keys; one commit is far cheaper than one per key, and the
   * snapshot is applied atomically.
   */
  transactionSync(callback) {
    if (!this.ready) return undefined
    return this.db.transactionSync(callback)
  }

  #queue(key, value, written) {
    const entry = {value}
    this.#pending.set(key, entry)
    const settle = () => {
      if (this.#pending.get(key) === entry) this.#pending.delete(key)
    }
    Promise.resolve(written).then(settle, error => {
      settle()
      console.error('\x1b[31m[Storage Error]\x1b[0m Write failed:', key, error?.message)
    })
  }

  /** Resolves once every queued write is committed. */
  flushed() {
    if (!this.ready || !this.db?.committed) return Promise.resolve()
    return Promise.resolve(this.db.committed)
  }

  /**
   * Entries whose key starts with `prefix`, including this process's queued writes.
   * Why: getRange() sees only committed data. A caller that moves a key space (session
   * regeneration at login) must also see writes and removes made earlier in the request.
   * @param {string} prefix
   * @returns {Map<string, *>}
   */
  entries(prefix) {
    const result = new Map()
    if (!this.ready) return result
    for (const {key, value} of this.db.getRange({start: prefix, end: prefix + '~'})) result.set(key, value)
    for (const [key, entry] of this.#pending) {
      if (typeof key !== 'string' || !key.startsWith(prefix)) continue
      if (entry.value === REMOVED) result.delete(key)
      else result.set(key, entry.value)
    }
    return result
  }

  // --- Range Operations ---

  getRange(options = {}) {
    if (!this.ready) return []
    return this.db.getRange(options)
  }

  getKeys(options = {}) {
    if (!this.ready) return []
    return this.db.getKeys(options)
  }

  // --- Session Garbage Collector ---

  startSessionGC(intervalMs = 60 * 60 * 1000, expirationMs = this.sessionLifetime) {
    if (!this.ready) {
      console.warn('[Storage] GC not started: Storage not ready')
      return null
    }

    if (this.gcInterval) {
      clearInterval(this.gcInterval)
    }

    this.gcInterval = setInterval(() => {
      this.cleanSessions(expirationMs).catch(error => console.error('\x1b[31m[Storage GC Error]\x1b[0m', error.message))
    }, intervalMs)

    return this.gcInterval
  }

  stopSessionGC() {
    if (this.gcInterval) {
      clearInterval(this.gcInterval)
      this.gcInterval = null
    }
  }

  /**
   * Removes expired sessions, form records and CSRF tokens.
   * Why: the GC runs on the primary, which also serves the memory IPC driver for every
   * worker. Keys are scanned in batches and the event loop is released between batches, so
   * a store with millions of keys never stalls IPC for the length of the scan. Overlapping
   * runs are skipped.
   * @param {number} [expirationMs] Session lifetime after the last activity.
   * @param {number} [batchSize=1000] Keys read per batch.
   * @returns {Promise<number>} Number of sessions removed.
   */
  async cleanSessions(expirationMs = this.sessionLifetime, batchSize = GC_BATCH_SIZE) {
    if (!this.ready || this.#gcRunning) return 0
    this.#gcRunning = true
    try {
      const now = Date.now()
      let count = 0
      let cursor = 'sess:'

      while (this.ready) {
        let lastKey = null
        let seen = 0
        for (const {key, value} of this.db.getRange({start: cursor, end: 'sess:~', limit: batchSize, snapshot: false})) {
          lastKey = key
          seen++
          if (key.endsWith(':_created') && sessionExpired(this.db, key, value, now, expirationMs)) {
            const prefix = key.slice(0, -':_created'.length)
            for (const subKey of this.db.getKeys({start: prefix, end: prefix + '~'})) this.db.remove(subKey)
            count++
          } else if (isExpiredFormRecord(key, value, now) || isExpiredToken(key, value, now)) {
            this.db.remove(key)
          }
        }
        if (lastKey === null || seen < batchSize) break
        cursor = lastKey + '\0'
        await new Promise(resolve => setImmediate(resolve))
      }

      if (count > 0) console.log(`\x1b[36m[Storage GC]\x1b[0m Cleaned ${count} expired sessions.`)
      return count
    } finally {
      this.#gcRunning = false
    }
  }

  // --- Utility ---

  /**
   * Commits queued writes and closes the database.
   * Why: writes are asynchronous; exiting without waiting would drop the last ones.
   * @returns {Promise<void>}
   */
  async close() {
    if (!this.db) return
    this.stopSessionGC()
    this.ready = false
    try {
      await this.db.committed
    } finally {
      await this.db.close()
      this.#pending.clear()
    }
  }

  isReady() {
    return this.ready
  }
}

module.exports = new OdacStorage()
