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
 * Key namespaces in Ipc:
 *   rc:{connection}:{table}:{queryHash}   — cached query result (Ipc.set/get with TTL)
 *   rc:idx:{connection}:{table}           — set of active cache keys for bulk invalidation
 *
 * API (exposed via Database.js proxy):
 *   Odac.DB.posts.cache(60).where({active: true}).select('id', 'title')  — TTL cache
 *   Odac.DB.posts.cache().where({id: 5}).first()                         — default TTL
 *   Odac.DB.posts.cache.clear()                                          — table invalidation
 *   Odac.DB.posts.cache.clear({id: 5})                                   — targeted invalidation
 *
 * Automatic invalidation:
 *   insert/update/delete on a table → all cached queries for that table are purged.
 */

const DEFAULT_CONFIG = {
  ttl: 300,
  maxKeys: 10000
}

class ReadCache {
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

  /**
   * Why: Generates a deterministic cache key from the Knex query builder's compiled SQL + bindings.
   * SHA-256 ensures fixed-length keys regardless of query complexity.
   * Sorting bindings is unnecessary — Knex preserves parameter order deterministically.
   *
   * @param {string} connection - Connection key (e.g., 'default', 'analytics')
   * @param {string} table - Table name
   * @param {object} queryBuilder - Knex query builder instance
   * @returns {string} Cache key in format rc:{connection}:{table}:{hash}
   */
  buildKey(connection, table, queryBuilder) {
    const {sql, bindings} = queryBuilder.toSQL()
    const hash = nodeCrypto
      .createHash('sha256')
      .update(`${sql}:${JSON.stringify(bindings)}`)
      .digest('hex')
    return `rc:${connection}:${table}:${hash}`
  }

  /**
   * Why: Core read-through logic. Returns cached result on HIT, executes query on MISS.
   * TTL ensures eventual consistency even without explicit invalidation.
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
    const cacheKey = this.buildKey(connection, table, queryBuilder)

    // O(1) cache lookup via Ipc
    const cached = await Odac.Ipc.get(cacheKey)
    if (cached !== null) return cached

    // MISS — execute the actual DB query via the original (unwrapped) .then()
    const result = await executeFn()

    // Guard against exceeding maxKeys to prevent unbounded memory growth
    const indexKey = `rc:idx:${connection}:${table}`
    const currentKeys = await Odac.Ipc.smembers(indexKey)

    if (currentKeys.length < this._config.maxKeys) {
      await Odac.Ipc.set(cacheKey, result, effectiveTtl)
      await Odac.Ipc.sadd(indexKey, cacheKey)

      // Cross-table invalidation: register cache key in joined tables' indexes too.
      // Why: A query like posts.join('users').cache().select() must be invalidated
      // when EITHER posts OR users is written to. Without this, a users.insert()
      // would leave stale joined data in the posts cache.
      const joinedTables = this._extractJoinedTables(queryBuilder)
      for (const joinedTable of joinedTables) {
        await Odac.Ipc.sadd(`rc:idx:${connection}:${joinedTable}`, cacheKey)
      }
    }

    return result
  }

  /**
   * Why: Purges all cached queries for a specific table. Called automatically on
   * insert/update/delete via Database.js proxy intercept.
   * Table-level granularity is intentional — row-level invalidation would require
   * parsing WHERE clauses of cached queries, which is O(n) and error-prone.
   *
   * @param {string} connection - Connection key
   * @param {string} table - Table name
   * @returns {Promise<void>}
   */
  async invalidate(connection, table) {
    if (!global.Odac?.Ipc) return

    const indexKey = `rc:idx:${connection}:${table}`
    const keys = await Odac.Ipc.smembers(indexKey)

    if (keys.length === 0) return

    // Delete all cached entries in parallel
    await Promise.all(keys.map(key => Odac.Ipc.del(key)))
    await Odac.Ipc.del(indexKey)
  }

  /**
   * Why: Extracts table names from JOIN clauses in a Knex query builder.
   * Used to register cache keys in joined tables' indexes for cross-table invalidation.
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
   * Why: Targeted invalidation — clears cache entries whose query hash matches
   * a specific WHERE condition. Falls back to full table invalidation since
   * precise row-level matching against arbitrary cached SQL is not feasible.
   * Exposed as Odac.DB.posts.cache.clear({id: 5}) for semantic clarity,
   * but internally equivalent to table-level purge.
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
