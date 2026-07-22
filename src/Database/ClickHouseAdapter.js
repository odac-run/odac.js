'use strict'

const {DIALECT, quoteIdent} = require('./ClickHouse')

/**
 * Thin connection adapter over `@clickhouse/client` for ODAC.
 *
 * Why not Knex: Knex has no first-party ClickHouse dialect, and ClickHouse's OLAP model
 * (no row-level UPDATE/DELETE transactions, no FK, batch-insert-oriented writes) does not
 * map onto the SQL query builder. Rather than fake a full Knex surface, this adapter exposes
 * the narrow, honest set of operations ODAC actually needs against ClickHouse:
 *   - raw(sql)            → run any statement (auto-routes reads vs. DDL/commands)
 *   - query(sql)          → SELECT/SHOW/DESCRIBE returning rows
 *   - exec(sql)           → DDL / commands with no result set
 *   - insert(table, rows) → batch INSERT (the one write pattern ClickHouse is built for)
 *   - hasTable(name) / columnInfo(name) → introspection for the migration engine
 *
 * Marked with `_odacDialect = 'clickhouse'` so Database.js, Migration and WriteBuffer can
 * branch away from their SQL/Knex code paths. The client is created lazily on first use so
 * merely constructing the adapter (e.g. in tests) never opens a socket.
 */
class ClickHouseAdapter {
  /**
   * @param {object} config - Normalized connection config {url, host, port, user, password, database, ...}
   * @param {string} key - Connection key (e.g. 'analytics')
   */
  constructor(config, key) {
    this._config = config
    this._client = null
    this._odacDialect = DIALECT
    this._odacConnectionKey = key
    // Mirrors the shape Knex exposes (knex.client.config.client) so dialect checks that read
    // `.client.config.client` still resolve for adapters that slip through a generic code path.
    this.client = {config: {client: DIALECT}}
  }

  /**
   * Lazily constructs the underlying @clickhouse/client instance.
   * @returns {object} ClickHouse client
   */
  _conn() {
    if (this._client) return this._client

    let createClient
    try {
      ;({createClient} = require('@clickhouse/client'))
    } catch {
      throw new Error('Database driver "@clickhouse/client" is not installed. Run: npm install @clickhouse/client')
    }

    const c = this._config
    const options = {
      username: c.user || c.username || 'default',
      password: c.password || '',
      database: c.database || 'default'
    }

    // Accept either an explicit url, or host/port assembled into an HTTP endpoint (CH default 8123).
    if (c.url) {
      options.url = c.url
    } else {
      const protocol = c.protocol || 'http'
      const host = c.host || '127.0.0.1'
      const port = c.port || 8123
      options.url = `${protocol}://${host}:${port}`
    }

    if (c.request_timeout || c.requestTimeout) options.request_timeout = c.request_timeout || c.requestTimeout

    this._client = createClient(options)
    return this._client
  }

  /**
   * Detects whether a statement returns rows (SELECT/SHOW/DESCRIBE/EXISTS/WITH) vs. a command.
   * @param {string} sql
   * @returns {boolean}
   */
  _isRead(sql) {
    return /^\s*(select|show|describe|desc|exists|with)\b/i.test(sql)
  }

  /**
   * Runs any SQL statement, auto-routing reads to query() and everything else to exec().
   * Mirrors the `knex.raw()` entry point used across ODAC (connection test, seeds, tracking).
   * @param {string} sql
   * @returns {Promise<Array<object>|void>} Rows for reads; undefined for commands
   */
  async raw(sql) {
    return this._isRead(sql) ? this.query(sql) : this.exec(sql)
  }

  /**
   * Executes a read query and returns rows as plain objects.
   * @param {string} sql
   * @returns {Promise<Array<object>>}
   */
  async query(sql) {
    const resultSet = await this._conn().query({query: sql, format: 'JSONEachRow'})
    return resultSet.json()
  }

  /**
   * Executes a DDL statement or command with no result set.
   * @param {string} sql
   * @returns {Promise<void>}
   */
  async exec(sql) {
    await this._conn().command({query: sql})
  }

  /**
   * Batch-inserts rows into a table — the write pattern ClickHouse is optimized for.
   * @param {string} table
   * @param {Array<object>} rows
   * @returns {Promise<void>}
   */
  async insert(table, rows) {
    if (!Array.isArray(rows) || rows.length === 0) return
    await this._conn().insert({table, values: rows, format: 'JSONEachRow'})
  }

  /**
   * Checks whether a table exists in the connection's database.
   * @param {string} tableName
   * @returns {Promise<boolean>}
   */
  async hasTable(tableName) {
    const rows = await this.query(`EXISTS TABLE ${quoteIdent(tableName)}`)
    return rows.length > 0 && Number(Object.values(rows[0])[0]) === 1
  }

  /**
   * Introspects a table's columns via system.columns, returning a Knex-columnInfo-shaped map
   * so the migration diff engine can compare desired vs. current column sets.
   * @param {string} tableName
   * @returns {Promise<Object<string, {type: string, nullable: boolean, defaultValue: *}>>}
   */
  async columnInfo(tableName) {
    const rows = await this.query(
      `SELECT name, type, default_expression FROM system.columns ` +
        `WHERE database = currentDatabase() AND table = ${literal(tableName)} ORDER BY position`
    )

    const info = {}
    for (const row of rows) {
      const rawType = String(row.type || '')
      const nullable = /^Nullable\(/.test(rawType)
      info[row.name] = {
        type: nullable ? rawType.replace(/^Nullable\((.*)\)$/, '$1') : rawType,
        nullable,
        defaultValue: row.default_expression || null
      }
    }
    return info
  }

  /**
   * Lists user tables in the connection's database (excludes system schemas).
   * @returns {Promise<string[]>}
   */
  async listTables() {
    const rows = await this.query(`SELECT name FROM system.tables WHERE database = currentDatabase()`)
    return rows.map(r => r.name)
  }

  /**
   * Closes the underlying client. Safe to call when the client was never opened.
   * @returns {Promise<void>}
   */
  async destroy() {
    if (this._client) {
      await this._client.close()
      this._client = null
    }
  }
}

/**
 * Local single-quote literal helper for introspection queries (adapter-internal).
 * @param {string} value
 * @returns {string}
 */
function literal(value) {
  return "'" + String(value).replace(/\\/g, '\\\\').replace(/'/g, "''") + "'"
}

module.exports = ClickHouseAdapter
