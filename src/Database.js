'use strict'
const {buildConnections} = require('./Database/ConnectionFactory')
const nanoid = require('./Database/nanoid')

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

    // Odac DX Improvement: Auto-generate NanoID for columns defined as type 'nanoid' in schema.
    // Why: Zero-config ID generation — no manual Odac.DB.nanoid() calls needed.
    const connectionKey = knexInstance._odacConnectionKey || 'default'
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
    if (prop === '_nanoidColumns') return target._nanoidColumns
    if (prop === '_loadNanoidMeta') return target._loadNanoidMeta.bind(target)

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
