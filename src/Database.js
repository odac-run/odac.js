'use strict'
const {buildConnections} = require('./Database/ConnectionFactory')

class DatabaseManager {
  constructor() {
    this.connections = {}
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
   * Called during shutdown to release connection pools and prevent resource leaks.
   */
  async close() {
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
    const nodeCrypto = require('crypto')
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
    let id = ''
    while (id.length < size) {
      const bytes = nodeCrypto.randomBytes(size + 5)
      for (let i = 0; i < bytes.length; i++) {
        const byte = bytes[i] & 63
        if (byte < 62) {
          id += alphabet[byte]
          if (id.length === size) break
        }
      }
    }
    return id
  }
}

const manager = new DatabaseManager()

const tableProxyHandler = {
  get(knexInstance, prop) {
    // 1. Check for legacy/alias methods
    if (prop === 'run') return knexInstance.raw.bind(knexInstance)
    if (prop === 'table')
      return function (tableName) {
        return knexInstance(tableName)
      }

    // 2. Pass through Knex instance methods (raw, schema, fn, destroy, etc.)
    if (typeof knexInstance[prop] === 'function') {
      return knexInstance[prop].bind(knexInstance)
    }
    if (prop in knexInstance) {
      return knexInstance[prop]
    }

    // 3. Assume it's a table name and return a Query Builder
    // But we need to be careful not to intercept Promise methods if they are accessed on the instance (though knex instance isn't a promise)

    // Create the Query Builder
    const qb = knexInstance(prop)

    // Odac DX Improvement: Wrap count() to return a clean number
    const originalCount = qb.count
    qb.count = function (...args) {
      this._odacIsCount = true
      return originalCount.apply(this, args)
    }

    const originalThen = qb.then
    qb.then = function (resolve, reject) {
      if (this._odacIsCount) {
        return originalThen.call(
          this,
          result => {
            // If the result is a single row with a single key, treat it as a scalar count usually
            const isScalar = Array.isArray(result) && result.length === 1 && Object.keys(result[0]).length === 1

            if (isScalar) {
              const keys = Object.keys(result[0])
              if (keys.length === 1) {
                const val = result[0][keys[0]]
                // Parse string numbers (common in Postgres for count)
                if (val != null && String(val).trim() !== '' && !isNaN(val)) {
                  resolve(Number(val))
                  return
                }
              }
            }
            resolve(result)
          },
          reject
        )
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
}

const rootProxy = new Proxy(manager, {
  get(target, prop) {
    // Access to internal manager methods
    if (prop === 'init') return target.init.bind(target)
    if (prop === 'close') return target.close.bind(target)
    if (prop === 'connections') return target.connections

    // Access to specific database connection: Odac.DB.analytics
    if (target.connections[prop]) {
      return new Proxy(target.connections[prop], tableProxyHandler)
    }

    // Direct access to raw/fn/schema/table on default connection
    if (target.connections['default'] && (prop === 'raw' || prop === 'fn' || prop === 'schema' || prop === 'table')) {
      if (prop === 'table')
        return function (tableName) {
          return target.connections['default'](tableName)
        }

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
  }
})

module.exports = rootProxy
