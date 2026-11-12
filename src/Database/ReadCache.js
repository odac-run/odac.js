'use strict'
const nodeCrypto = require('node:crypto')

/**
 * Read-Through Cache for ODAC Database layer.
 *
 * Why: Frequently-read, rarely-changed data (blog posts, settings, categories)
 * generates redundant DB queries across workers. This module caches SELECT results
 * via the Ipc layer, providing O(1) reads after the first query.
 *
 * Architecture: Fully delegated to Odac.Ipc for state management (same as WriteBuffer).
 * - Memory driver: Primary process holds cached data in Maps via cluster IPC.
 * - Redis driver: All state lives in Redis — works across horizontal load balancers.
 * - Both drivers: TTL-based expiration + automatic invalidation on write operations.
 *
 * Invalidation is versioned: every table has a counter, and a cache key embeds the current
 * counter of each table the query reads. A write bumps the counter, so later reads look up
 * keys that do not exist yet; superseded entries are never read again and expire with their
 * TTL. A per-table index of keys used to serve this purpose, but entries that expired were
 * never removed from it, so a table that was never written stopped caching for good once
 * the index reached maxKeys, and every miss fetched the whole index.
 *
 * Key namespaces in Ipc:
 *   rc:v:{connection}:{table}                         — table version counter (no TTL)
 *   rc:{connection}:{table}:{queryHash}               — cached query result (TTL)
 *   rc:n:{connection}:{table}:{version}               — entries stored in the current window
 *
 * API (exposed via Database.js proxy):
 *   Odac.DB.posts.cache(60).where({active: true}).select('id', 'title')  — TTL cache
 *   Odac.DB.posts.cache().where({id: 5}).first()                         — default TTL
 *   Odac.DB.posts.cache.clear()                                          — table invalidation
 *
 * Automatic invalidation:
 *   insert/update/delete on a table → all cached queries that read it are superseded.
 */

const DEFAULT_CONFIG = {
  ttl: 300,
  maxKeys: 10000
}

// Values pass through JSON (process.send / Redis). Dates and Buffers are tagged so a HIT
// returns the same types as the MISS that filled it. The envelope keeps `undefined` (what
// .first() returns for no row) distinguishable from a miss.
const TYPE_TAG = '\u0000odac'

function encode(value) {
  return JSON.stringify({v: value}, function (key, current) {
    const raw = this[key]
    if (raw instanceof Date) return {[TYPE_TAG]: 'date', v: raw.getTime()}
    if (Buffer.isBuffer(raw)) return {[TYPE_TAG]: 'buffer', v: raw.toString('base64')}
    return current
  })
}

function decode(text) {
  return JSON.parse(text, (key, value) => {
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value, TYPE_TAG)) return value
    if (value[TYPE_TAG] === 'date') return new Date(value.v)
    if (value[TYPE_TAG] === 'buffer') return Buffer.from(value.v, 'base64')
    return value
  }).v
}

class ReadCache {
  // Misses in flight in this process, by cache key: concurrent identical queries share one
  // database round trip instead of all hitting the database at once.
  #inflight = new Map()

  constructor() {
    this._config = {}
  }

  /**
   * Why: Merges user config with sensible defaults. Called from Database.init().
   * No timers or background processes — cache is purely reactive (read-through + TTL).
   */
  init() {
    this._config = {...DEFAULT_CONFIG, ...Odac.Config.cache}
  }

  #versionKey(connection, table) {
    return `rc:v:${connection}:${table}`
  }

  /**
   * Why: Generates a deterministic cache key from the compiled SQL, its bindings and the
   * current version of every table involved. SHA-256 keeps keys fixed-length.
   *
   * @param {string} connection - Connection key (e.g., 'default', 'analytics')
   * @param {string} table - Table name
   * @param {object} queryBuilder - Knex query builder instance
   * @param {Array<number>} [versions] - Versions of [table, ...joined tables]
   * @returns {string} Cache key in format rc:{connection}:{table}:{hash}
   */
  buildKey(connection, table, queryBuilder, versions = []) {
    const {sql, bindings} = queryBuilder.toSQL()
    const hash = nodeCrypto
      .createHash('sha256')
      .update(`${sql}:${JSON.stringify(bindings)}:${versions.join(',')}`)
      .digest('hex')
    return `rc:${connection}:${table}:${hash}`
  }

  /**
   * Why: Core read-through logic. Returns cached result on HIT, executes query on MISS.
   * Versions are read before the query runs, so a result that raced with a write is stored
   * under the superseded version and never served.
   *
   * @param {string} connection - Connection key
   * @param {string} table - Table name
   * @param {object} queryBuilder - Knex query builder (used for key generation via .toSQL())
   * @param {function} executeFn - Callback that executes the original DB query (avoids .then() recursion)
   * @param {number} ttl - Time-to-live in seconds
   * @returns {Promise<*>} Query result (from cache or DB)
   */
  async get(connection, table, queryBuilder, executeFn, ttl) {
    const effectiveTtl = ttl || this._config.ttl
    const tables = [table, ...this._extractJoinedTables(queryBuilder).filter(name => name !== table)]
    const versions = await Promise.all(tables.map(name => Odac.Ipc.get(this.#versionKey(connection, name))))
    const normalized = versions.map(version => Number(version) || 0)
    const cacheKey = this.buildKey(connection, table, queryBuilder, normalized)

    const cached = await Odac.Ipc.get(cacheKey)
    if (typeof cached === 'string') return decode(cached)

    const pending = this.#inflight.get(cacheKey)
    if (pending) return pending

    const load = (async () => {
      const result = await executeFn()
      await this.#store(connection, table, normalized[0], cacheKey, result, effectiveTtl)
      return result
    })()
    this.#inflight.set(cacheKey, load)
    try {
      return await load
    } finally {
      this.#inflight.delete(cacheKey)
    }
  }

  // Caps how many entries one table version stores per TTL window, so a flood of distinct
  // queries cannot grow the store without bound between expirations.
  async #store(connection, table, version, cacheKey, result, ttl) {
    try {
      const stored = await Odac.Ipc.incrBy(`rc:n:${connection}:${table}:${version}`, 1, this._config.ttl)
      if (stored > this._config.maxKeys) return
      await Odac.Ipc.set(cacheKey, encode(result), ttl)
    } catch (error) {
      // The query already succeeded; failing to cache it must not fail the read.
      console.error(`\x1b[31m[ODAC ReadCache]\x1b[0m Failed to cache a "${table}" query:`, error?.message)
    }
  }

  /**
   * Why: Supersedes all cached queries that read a table. Called automatically on
   * insert/update/delete via Database.js proxy intercept. One counter increment, whatever
   * the number of cached queries.
   *
   * @param {string} connection - Connection key
   * @param {string} table - Table name
   * @returns {Promise<void>}
   */
  async invalidate(connection, table) {
    if (!global.Odac?.Ipc) return
    await Odac.Ipc.incrBy(this.#versionKey(connection, table), 1)
  }

  /**
   * Why: Extracts table names from JOIN clauses in a Knex query builder.
   * Their versions are part of the key, so a write to a joined table supersedes the query.
   * Parses Knex's internal _statements array — entries with a joinType property
   * contain the joined table name. Handles aliased tables (e.g., 'users as u' → 'users').
   *
   * @param {object} queryBuilder - Knex query builder instance
   * @returns {string[]} Array of joined table names (deduplicated)
   */
  _extractJoinedTables(queryBuilder) {
    const statements = queryBuilder._statements
    if (!statements || !Array.isArray(statements)) return []

    const tables = new Set()
    for (const stmt of statements) {
      if (!stmt.joinType || !stmt.table) continue
      // Handle aliased tables: 'users as u' → 'users'
      const tableName = String(stmt.table)
        .split(/\s+as\s+/i)[0]
        .trim()
      if (tableName) tables.add(tableName)
    }
    return [...tables]
  }

  /**
   * Why: Manual invalidation, exposed as Odac.DB.posts.cache.clear(). Row-level matching
   * against arbitrary cached SQL is not feasible, so it supersedes the whole table.
   *
   * @param {string} connection - Connection key
   * @param {string} table - Table name
   * @returns {Promise<void>}
   */
  async clear(connection, table) {
    return this.invalidate(connection, table)
  }
}

module.exports = new ReadCache()
