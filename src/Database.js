'use strict'
const {buildConnections} = require('./Database/ConnectionFactory')
const nanoid = require('./Database/nanoid')
const readCache = require('./Database/ReadCache')
const writeBuffer = require('./Database/WriteBuffer')
const {DIALECT: CLICKHOUSE} = require('./Database/ClickHouse')
const ClickHouseQuery = require('./Database/ClickHouseQuery')

class DatabaseManager {
  constructor() {
    this.connections = {}
    /** @type {Object<string, Object<string, Array<{column: string, size: number}>>>} connectionKey -> tableName -> nanoid columns */
    this._nanoidColumns = {}
  }

  async init() {
    if (!Odac.Config.database) return

    this.connections = buildConnections(Odac.Config.database)

    for (const key of Object.keys(this.connections)) {
      // Test connection
      try {
        await this.connections[key].raw('SELECT 1')
      } catch (e) {
        console.error(`Odac Database Error: Failed to connect to '${key}' database.`)
        console.error(e.message)
      }
    }

    // Auto-migrate: sync schema/ files with the database on every startup.
    // Why: Zero-config philosophy — deploy and forget. The app always starts with the correct DB state.
    await this._autoMigrate()

    // Cache nanoid column metadata from schema files for insert-time auto-generation.
    // Runs on ALL processes (primary + workers) since every process may insert data.
    this._loadNanoidMeta()

    // Initialize Read-Through Cache (all processes — every worker may read cached data)
    readCache.init()

    // Initialize Write-Behind Cache (Primary holds state, Workers communicate via IPC)
    await writeBuffer.init(this.connections, this._nanoidColumns)
  }

  /**
   * Runs the schema-first migration engine against all active connections.
   * CLUSTER SAFETY: Only runs on the primary process to prevent race conditions.
   * Workers are forked AFTER Server.init(), which happens after Database.init(),
   * so migrations are guaranteed to complete before any worker touches the DB.
   * Silently skips if no schema/ directory exists (no-op for projects without migrations).
   */
  async _autoMigrate() {
    const cluster = require('node:cluster')
    if (!cluster.isPrimary) return

    const fs = require('node:fs')
    const path = require('node:path')
    const schemaDir = path.join(global.__dir, 'schema')

    if (!fs.existsSync(schemaDir)) return
    if (Object.keys(this.connections).length === 0) return

    const Migration = require('./Database/Migration')
    Migration.init(global.__dir, this.connections)

    try {
      await Migration.migrate()
    } catch (e) {
      throw new Error(`Odac Migration Error: ${e.message}`, {cause: e})
    }
  }

  /**
   * Gracefully destroys all active database connections.
   * Flushes WriteBuffer before closing to prevent data loss.
   * Called during shutdown to release connection pools and prevent resource leaks.
   */
  async close() {
    // Flush buffered writes before destroying connections
    try {
      await writeBuffer.close()
    } catch (err) {
      console.error('\x1b[31m[Database]\x1b[0m WriteBuffer close error:', err.message)
    }

    const entries = Object.entries(this.connections)
    if (entries.length === 0) return

    await Promise.allSettled(
      entries.map(([name, knex]) =>
        knex.destroy().catch(err => {
          console.error(`\x1b[31m[Database]\x1b[0m Failed to close '${name}' connection:`, err.message)
        })
      )
    )
    this.connections = {}
  }

  nanoid(size = 21) {
    return nanoid(size)
  }

  /**
   * Scans schema/ directory and caches which columns are type 'nanoid' per table.
   * Why: The insert() proxy needs O(1) lookup to auto-generate IDs at runtime.
   * Lightweight — only reads file metadata, no DB introspection.
   */
  _loadNanoidMeta() {
    const fs = require('node:fs')
    const path = require('node:path')
    const Module = require('node:module')

    if (!global.__dir) return
    const schemaDir = path.join(global.__dir, 'schema')
    if (!fs.existsSync(schemaDir)) return

    const loadDir = (dir, connectionKey) => {
      if (!this._nanoidColumns[connectionKey]) {
        this._nanoidColumns[connectionKey] = {}
      }

      const files = fs.readdirSync(dir).filter(f => f.endsWith('.js') && fs.statSync(path.join(dir, f)).isFile())

      for (const file of files) {
        const filePath = path.join(dir, file)
        const tableName = path.basename(file, '.js')

        try {
          const source = fs.readFileSync(filePath, 'utf8')
          const m = new Module(filePath)
          m.filename = filePath
          m.paths = Module._nodeModulePaths(path.dirname(filePath))
          m._compile(source, filePath)
          const schema = m.exports

          if (!schema?.columns) continue

          const nanoidCols = []
          for (const [colName, colDef] of Object.entries(schema.columns)) {
            if (colDef.type === 'nanoid') {
              nanoidCols.push({column: colName, size: colDef.length || 21})
            }
          }

          if (nanoidCols.length > 0) {
            this._nanoidColumns[connectionKey][tableName] = nanoidCols
          }
        } catch (e) {
          // Schema file parse error — skip silently, Migration will report it
          if (global.Odac?.Config?.debug) {
            console.warn(`\x1b[33m[ODAC NanoID Meta]\x1b[0m Failed to parse schema ${filePath}:`, e.message)
          }
        }
      }
    }

    // Root-level files (default connection)
    loadDir(schemaDir, 'default')

    // Subdirectories (named connections)
    const entries = fs.readdirSync(schemaDir, {withFileTypes: true})
    for (const entry of entries) {
      if (entry.isDirectory()) {
        loadDir(path.join(schemaDir, entry.name), entry.name)
      }
    }
  }
}

const manager = new DatabaseManager()

/**
 * Normalizes a count() result into a plain number.
 * Postgres returns counts as strings, and Knex wraps them in [{'count(*)': n}].
 */
const normalizeCountResult = result => {
  const isScalar = Array.isArray(result) && result.length === 1 && Object.keys(result[0]).length === 1
  if (!isScalar) return result

  const val = result[0][Object.keys(result[0])[0]]
  if (val != null && String(val).trim() !== '' && !isNaN(val)) return Number(val)
  return result
}

/**
 * Builds an ODAC-enriched Knex query builder for a table.
 * Why: Both `Odac.DB.apps` and `Odac.DB.table('apps')` must return the SAME object —
 * one carrying .cache()/.buffer and the write-invalidation wrappers. Sharing one
 * factory keeps the two access styles from drifting apart.
 */
const buildQueryBuilder = (knexInstance, tableName) => {
  const prop = tableName
  const qb = knexInstance(prop)
  const connectionKey = knexInstance._odacConnectionKey || 'default'

  // Write-Behind Cache: Odac.DB.posts.buffer.where(id).update({...}) / .increment('col') / .get('col')
  //                     Odac.DB.posts.buffer.insert(row) / .flush()
  qb.buffer = {
    where: where => ({
      update: data => writeBuffer.update(connectionKey, prop, where, data),
      increment: (column, delta = 1) => writeBuffer.increment(connectionKey, prop, where, column, delta),
      get: column => writeBuffer.get(connectionKey, prop, where, column)
    }),
    insert: row => writeBuffer.insert(connectionKey, prop, row),
    flush: () => writeBuffer.flush(connectionKey, prop)
  }

  // Read-Through Cache: Odac.DB.posts.cache(60).where({active: true}).select('id', 'title')
  //                     Odac.DB.posts.cache().where({id: 5}).first()
  //                     Odac.DB.posts.cache.clear()
  // Why: Returns a Proxy that intercepts .then() to inject cache lookup before DB execution.
  // The ttl parameter on cache() sets per-query TTL; omit for config default.
  const cacheFactory = ttl => {
    // clone() — NOT a fresh builder. Anything chained before .cache() (e.g.
    // .where('status', 'active').cache(60)) must survive; a fresh builder would
    // silently drop those clauses and cache the results of a different query.
    // Knex's clone() copies the statements but none of the ODAC overrides below,
    // so the .then() we install here cannot recurse into itself.
    const cachedQb = qb.clone()
    cachedQb._odacCacheTtl = ttl || 0

    const originalCachedCount = cachedQb.count
    cachedQb.count = function (...args) {
      this._odacIsCount = true
      return originalCachedCount.apply(this, args)
    }

    // Capture the ORIGINAL .then() before overriding — prevents infinite recursion
    // when ReadCache.get() needs to execute the actual DB query on cache MISS.
    const originalCacheThen = cachedQb.then.bind(cachedQb)
    cachedQb.then = function (resolve, reject) {
      const executeFn = () => new Promise((res, rej) => originalCacheThen(res, rej))
      return readCache
        .get(connectionKey, prop, this, executeFn, this._odacCacheTtl)
        .then(result => (this._odacIsCount ? normalizeCountResult(result) : result))
        .then(resolve, reject)
    }

    return cachedQb
  }

  qb.cache = Object.assign(cacheFactory, {
    clear: () => readCache.clear(connectionKey, prop)
  })

  // Automatic cache invalidation on write operations (insert/update/delete/truncate).
  // Why: Prevents stale reads — any mutation on a table purges all cached SELECT results.
  // Write methods are terminal (no further chaining after await), so wrapping the return
  // as a simple thenable is safe and avoids .then() override conflicts with count/other wraps.
  const wrapWithInvalidation = original =>
    function (...args) {
      const qbResult = original.apply(this, args)
      const thenable = {
        then: (resolve, reject) =>
          qbResult.then(res => readCache.invalidate(connectionKey, prop).then(() => res), reject).then(resolve, reject),
        catch: fn => thenable.then(undefined, fn)
      }
      return thenable
    }

  const originalUpdate = qb.update
  const originalDelete = qb.delete
  const originalDel = qb.del
  const originalTruncate = qb.truncate
  qb.update = wrapWithInvalidation(originalUpdate)
  qb.delete = wrapWithInvalidation(originalDelete)
  qb.del = wrapWithInvalidation(originalDel)
  qb.truncate = wrapWithInvalidation(originalTruncate)

  // Odac DX Improvement: Wrap count() to return a clean number
  const originalCount = qb.count
  qb.count = function (...args) {
    this._odacIsCount = true
    return originalCount.apply(this, args)
  }

  // Odac DX Improvement: Auto-generate NanoID for columns defined as type 'nanoid' in schema.
  // Why: Zero-config ID generation — no manual Odac.DB.nanoid() calls needed.
  const nanoidCols = manager._nanoidColumns[connectionKey]?.[prop]
  if (nanoidCols) {
    const originalInsert = qb.insert
    qb.insert = function (data, ...args) {
      if (Array.isArray(data)) {
        for (const row of data) {
          for (const {column, size} of nanoidCols) {
            if (!row[column]) row[column] = manager.nanoid(size)
          }
        }
      } else if (data && typeof data === 'object') {
        for (const {column, size} of nanoidCols) {
          if (!data[column]) data[column] = manager.nanoid(size)
        }
      }
      return originalInsert.call(this, data, ...args)
    }
  }

  // Cache invalidation for insert — applied AFTER nanoid wrap so both paths are covered.
  // IMPORTANT: Unlike update/delete/truncate, insert is NOT terminal — it supports
  // chaining (e.g. .insert().onConflict().merge()). So we cannot use wrapWithInvalidation
  // which returns a plain thenable. Instead, override .then() on the query builder to
  // inject invalidation at execution time, preserving the full Knex chain.
  const insertBeforeInvalidation = qb.insert
  qb.insert = function (...args) {
    const result = insertBeforeInvalidation.apply(this, args)
    const origThen = result.then
    result.then = function (resolve, reject) {
      return origThen
        .call(this)
        .then(res => readCache.invalidate(connectionKey, prop).then(() => res))
        .then(resolve, reject)
    }
    return result
  }

  const originalThen = qb.then
  qb.then = function (resolve, reject) {
    if (this._odacIsCount) {
      return originalThen.call(this, result => resolve(normalizeCountResult(result)), reject)
    }
    return originalThen.call(this, resolve, reject)
  }

  // 4. Extend the Query Builder with ODAC specific methods

  // .schema(callback) for "Code-First" migrations
  // Usage: await Odac.DB.users.schema(t => { t.string('name') })
  qb.schema = async function (callback) {
    const exists = await knexInstance.schema.hasTable(prop)
    if (!exists) {
      await knexInstance.schema.createTable(prop, callback)
    }
    return this
  }

  return qb
}

/**
 * Builds the table surface for a ClickHouse (OLAP) connection.
 * Why: ClickHouse has no Knex query builder, no row-level UPDATE/increment, and no read-through
 * cache invalidation model. Rather than pretend, we expose what ClickHouse does well: batch insert
 * (direct or buffered) and a fluent SELECT builder (ClickHouseQuery). Row-level update/delete and
 * .cache() are intentionally absent — they are OLTP-only.
 *
 *   Odac.DB.analytics.events.insert(row | [...rows])              — batch insert (single or array)
 *   Odac.DB.analytics.events.buffer.insert(row)                  — write-behind batched insert
 *   Odac.DB.analytics.events.select('path','count() AS c').groupBy('path')  — fluent read
 *   Odac.DB.analytics.events.where({user_id: 42}).first()        — fluent read → single row
 *   Odac.DB.analytics.events.query('SELECT ...')                 — table-scoped raw read
 *   Odac.DB.analytics.raw('SELECT ...')                          — connection-level raw
 * @param {object} adapter - ClickHouseAdapter instance
 * @param {string} tableName - Target table
 * @returns {ClickHouseQuery} Fluent read builder augmented with write/raw helpers
 */
const buildClickHouseTable = (adapter, tableName) => {
  const connectionKey = adapter._odacConnectionKey || 'default'

  // A fresh builder per access (like buildQueryBuilder) — no chained-state leakage between calls.
  const query = new ClickHouseQuery(adapter, tableName)

  // Batch insert accepts a single object or an array for DX parity with the SQL path.
  query.insert = rows => adapter.insert(tableName, Array.isArray(rows) ? rows : [rows])
  query.raw = sql => adapter.raw(sql)
  query.query = sql => adapter.query(sql)
  query.buffer = {
    insert: row => writeBuffer.insert(connectionKey, tableName, row),
    flush: () => writeBuffer.flush(connectionKey, tableName)
  }

  return query
}

/**
 * Proxy handler for a ClickHouse connection — passes through adapter methods (raw/query/exec/
 * insert/hasTable/columnInfo/destroy) and treats any other property as a table name.
 * @param {object} adapter - ClickHouseAdapter instance
 * @param {string|symbol} prop
 * @returns {*}
 */
const clickhouseProxyGet = (adapter, prop) => {
  if (prop === 'run') return sql => adapter.raw(sql)
  if (prop === 'table') return tableName => buildClickHouseTable(adapter, tableName)

  if (typeof adapter[prop] === 'function') return adapter[prop].bind(adapter)
  if (prop in adapter) return adapter[prop]

  return buildClickHouseTable(adapter, prop)
}

const tableProxyHandler = {
  get(knexInstance, prop) {
    // ClickHouse connections are adapters, not Knex — route to the restricted OLAP surface.
    if (knexInstance._odacDialect === CLICKHOUSE) {
      return clickhouseProxyGet(knexInstance, prop)
    }

    // 1. Check for legacy/alias methods
    if (prop === 'run') return knexInstance.raw.bind(knexInstance)
    if (prop === 'table') return tableName => buildQueryBuilder(knexInstance, tableName)

    // 2. Pass through Knex instance methods (raw, schema, fn, destroy, etc.)
    if (typeof knexInstance[prop] === 'function') {
      return knexInstance[prop].bind(knexInstance)
    }
    if (prop in knexInstance) {
      return knexInstance[prop]
    }

    // 3. Assume it's a table name and return an ODAC-enriched Query Builder
    return buildQueryBuilder(knexInstance, prop)
  }
}

const rootProxy = new Proxy(manager, {
  get(target, prop) {
    // Access to internal manager methods
    if (prop === 'init') return target.init.bind(target)
    if (prop === 'close') return target.close.bind(target)
    if (prop === 'connections') return target.connections
    if (prop === '_nanoidColumns') return target._nanoidColumns
    if (prop === '_loadNanoidMeta') return target._loadNanoidMeta.bind(target)

    // Global WriteBuffer: Odac.DB.buffer.flush()
    if (prop === 'buffer') {
      return {
        flush: (connection, table) => writeBuffer.flush(connection, table)
      }
    }

    // Global ReadCache: Odac.DB.cache.clear(connection, table)
    if (prop === 'cache') {
      return {
        clear: (connection, table) => readCache.clear(connection, table)
      }
    }

    // Access to specific database connection: Odac.DB.analytics
    if (target.connections[prop]) {
      return new Proxy(target.connections[prop], tableProxyHandler)
    }

    // Direct access to raw/fn/schema/table on default connection
    if (target.connections['default'] && (prop === 'raw' || prop === 'fn' || prop === 'schema' || prop === 'table')) {
      // ClickHouse default connection: route through the adapter's restricted surface.
      if (target.connections['default']._odacDialect === CLICKHOUSE) {
        return clickhouseProxyGet(target.connections['default'], prop)
      }
      if (prop === 'table') return tableName => buildQueryBuilder(target.connections['default'], tableName)

      const val = target.connections['default'][prop]
      if (typeof val === 'function') {
        return val.bind(target.connections['default'])
      }
      return val
    }

    // Expose nanoid helper directly on Odac.DB.nanoid()
    if (prop === 'nanoid') return target.nanoid.bind(target)

    // Default connection fallback: Odac.DB.users -> default.users
    if (target.connections['default']) {
      return tableProxyHandler.get(target.connections['default'], prop)
    }

    return undefined
  },

  set(target, prop, value) {
    if (prop === 'connections' || prop === '_nanoidColumns') {
      target[prop] = value
      return true
    }
    return false
  }
})

module.exports = rootProxy
