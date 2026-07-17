'use strict'

const knex = require('knex')
const ClickHouseAdapter = require('./ClickHouseAdapter')

/**
 * Resolves knex client driver from ODAC database type.
 * Why: Keeps connection driver mapping consistent across runtime and CLI migration paths.
 * ClickHouse resolves to the sentinel 'clickhouse' — it is NOT a Knex client and is served
 * by ClickHouseAdapter instead (see buildConnections).
 * @param {string} type Database type from config.
 * @returns {string} Knex client name, or 'clickhouse' for the ClickHouse adapter.
 */
function resolveClient(type) {
  if (type === 'postgres' || type === 'pg' || type === 'postgresql') return 'pg'
  if (type === 'sqlite' || type === 'sqlite3') return 'sqlite3'
  if (type === 'clickhouse' || type === 'ch') return 'clickhouse'
  return 'mysql2'
}

/**
 * Builds knex connection config from ODAC database node.
 * Why: Normalizes connection options for all call sites and avoids drift.
 * @param {object} db Single database config node.
 * @param {string} client Knex client name.
 * @returns {object} Knex connection object.
 */
function buildConnectionConfig(db, client) {
  if (client === 'sqlite3') {
    return {filename: db.filename || db.database || './dev.sqlite3'}
  }

  return {
    host: db.host || '127.0.0.1',
    user: db.user,
    password: db.password,
    database: db.database,
    port: db.port
  }
}

/** @type {Record<string, string>} Maps ODAC db type to the npm package that must be installed */
const DRIVER_PACKAGES = {
  pg: 'pg',
  mysql2: 'mysql2',
  sqlite3: 'sqlite3'
}

/**
 * Creates knex connections map from ODAC database config.
 * Why: Centralizes zero-config connection bootstrap used by runtime and migration CLI.
 * @param {object} databaseConfig ODAC database config (single or multiple).
 * @returns {Record<string, any>} Knex connections by key.
 */
function buildConnections(databaseConfig) {
  const isMultiple = typeof databaseConfig[Object.keys(databaseConfig)[0]] === 'object'
  const dbs = isMultiple ? databaseConfig : {default: databaseConfig}
  const connections = {}

  for (const key of Object.keys(dbs)) {
    const db = dbs[key]
    const client = resolveClient(db.type)

    // ClickHouse (OLAP) is not a Knex dialect — serve it with the dedicated adapter.
    // The adapter lazy-connects, so buildConnections stays side-effect-free until first query.
    if (client === 'clickhouse') {
      connections[key] = new ClickHouseAdapter(db, key)
      continue
    }

    const connection = buildConnectionConfig(db, client)

    const pkg = DRIVER_PACKAGES[client]
    if (pkg) {
      try {
        require(pkg)
      } catch {
        throw new Error(`Database driver "${pkg}" is not installed. Run: npm install ${pkg}`)
      }
    }

    connections[key] = knex({
      client,
      connection,
      pool: {min: 0, max: db.connectionLimit || 10},
      useNullAsDefault: true
    })
    connections[key]._odacConnectionKey = key
  }

  return connections
}

module.exports = {
  buildConnections,
  buildConnectionConfig,
  resolveClient
}
