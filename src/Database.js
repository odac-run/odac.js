'use strict'
const knex = require('knex')

class DatabaseManager {
  constructor() {
    this.connections = {}
  }

  async init() {
    if (!Odac.Config.database) return

    let multiple = typeof Odac.Config.database[Object.keys(Odac.Config.database)[0]] === 'object'
    let dbs = multiple ? Odac.Config.database : {default: Odac.Config.database}

    for (let key of Object.keys(dbs)) {
      let db = dbs[key]
      let client = 'mysql2'
      if (db.type === 'postgres' || db.type === 'pg' || db.type === 'postgresql') client = 'pg'
      if (db.type === 'sqlite' || db.type === 'sqlite3') client = 'sqlite3'

      let connectionConfig = {}
      
      if (client === 'sqlite3') {
        connectionConfig = {
          filename: db.filename || db.database || './dev.sqlite3'
        }
      } else {
        connectionConfig = {
          host: db.host || '127.0.0.1',
          user: db.user,
          password: db.password,
          database: db.database,
          port: db.port
        }
      }

      this.connections[key] = knex({
        client: client,
        connection: connectionConfig,
        pool: {
          min: 0,
          max: db.connectionLimit || 10
        },
        useNullAsDefault: true // For sqlite
      })

      // Test connection
      try {
        await this.connections[key].raw('SELECT 1')
      } catch (e) {
        console.error(`Odac Database Error: Failed to connect to '${key}' database.`)
        console.error(e.message)
      }
    }
  }
}

const manager = new DatabaseManager()

const tableProxyHandler = {
  get(knexInstance, prop) {
    // 1. Check for legacy/alias methods
    if (prop === 'run') return knexInstance.raw.bind(knexInstance)
    if (prop === 'table') return function(tableName) { return knexInstance(tableName) }
    
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
    qb.count = function(...args) {
      this._odacIsCount = true
      return originalCount.apply(this, args)
    }

    const originalThen = qb.then
    qb.then = function(resolve, reject) {
      if (this._odacIsCount) {
        return originalThen.call(this, (result) => {
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
        }, reject)
      }
      return originalThen.call(this, resolve, reject)
    }

    // 4. Extend the Query Builder with ODAC specific methods
    
    // .schema(callback) for "Code-First" migrations
    // Usage: await Odac.DB.users.schema(t => { t.string('name') })
    qb.schema = async function(callback) {
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
    if (prop === 'connections') return target.connections
    
    // Access to specific database connection: Odac.DB.analytics
    if (target.connections[prop]) {
      return new Proxy(target.connections[prop], tableProxyHandler)
    }

    // Direct access to raw/fn/schema/table on default connection
    if (target.connections['default'] && (prop === 'raw' || prop === 'fn' || prop === 'schema' || prop === 'table')) {
        if (prop === 'table') return function(tableName) { return target.connections['default'](tableName) }
        return target.connections['default'][prop].bind(target.connections['default']);
    }

    // Default connection fallback: Odac.DB.users -> default.users
    if (target.connections['default']) {
      return tableProxyHandler.get(target.connections['default'], prop)
    }

    return undefined
  }
})

module.exports = rootProxy
