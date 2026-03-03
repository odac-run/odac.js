'use strict'

const knex = require('knex')

/**
 * Resolves knex client driver from ODAC database type.
 * Why: Keeps connection driver mapping consistent across runtime and CLI migration paths.
 * @param {string} type Database type from config.
 * @returns {string} Knex client name.
 */
function resolveClient(type) {
  if (type === 'postgres' || type === 'pg' || type === 'postgresql') return 'pg'
  if (type === 'sqlite' || type === 'sqlite3') return 'sqlite3'
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
    const connection = buildConnectionConfig(db, client)

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
