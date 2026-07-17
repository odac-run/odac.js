'use strict'

const {quoteIdent, quoteLiteral} = require('./ClickHouse')

/**
 * Lightweight fluent read query builder for ClickHouse.
 *
 * Why not Knex: ClickHouse has no Knex dialect, and its OLTP-style write chains (update/delete)
 * are anti-patterns here. But analytical READS benefit from an ergonomic builder, so this class
 * offers a small, safe, chainable SELECT surface that compiles straight to ClickHouse SQL.
 *
 * Safety: identifiers are backtick-quoted and values are escaped as ClickHouse literals
 * (numbers bare, strings single-quoted). There is no string concatenation of untrusted input
 * without escaping. The builder is thenable — awaiting it executes the query.
 *
 *   await Odac.DB.analytics.events.select('path', 'count() AS c').groupBy('path').orderBy('c', 'desc').limit(10)
 *   await Odac.DB.analytics.events.where({user_id: 42}).orderBy('created_at', 'desc').first()
 *   await Odac.DB.analytics.events.where('created_at', '>=', '2026-01-01').count()
 */
class ClickHouseQuery {
  /**
   * @param {object} adapter - ClickHouseAdapter instance
   * @param {string} table - Target table name
   */
  constructor(adapter, table) {
    this._adapter = adapter
    this._table = table
    this._columns = ['*']
    this._wheres = []
    this._groupBy = []
    this._orderBy = []
    this._limit = null
    this._offset = null
    this._isCount = false
  }

  /**
   * Sets the selected columns/expressions. Expressions (e.g. 'count() AS c') pass through verbatim;
   * plain identifiers are used as-is to allow functions and aliases. Call with no args to keep '*'.
   * @param {...string} cols
   * @returns {ClickHouseQuery}
   */
  select(...cols) {
    if (cols.length > 0) this._columns = cols.flat()
    return this
  }

  /**
   * Adds a WHERE condition. Forms:
   *   where({a: 1, b: 2})        → a = 1 AND b = 2
   *   where('a', 1)              → a = 1
   *   where('a', '>', 1)         → a > 1
   *   where('a', null)           → a IS NULL
   * @param {string|object} column
   * @param {*} [opOrValue]
   * @param {*} [value]
   * @returns {ClickHouseQuery}
   */
  where(column, opOrValue, value) {
    if (column !== null && typeof column === 'object') {
      for (const [col, val] of Object.entries(column)) {
        this._pushCondition(col, '=', val)
      }
      return this
    }

    if (arguments.length === 2) {
      this._pushCondition(column, '=', opOrValue)
    } else {
      this._pushCondition(column, opOrValue, value)
    }
    return this
  }

  /**
   * Adds a WHERE column IN (...) condition.
   * @param {string} column
   * @param {Array} values
   * @returns {ClickHouseQuery}
   */
  whereIn(column, values) {
    if (!Array.isArray(values) || values.length === 0) {
      // An empty IN () is invalid SQL and logically matches nothing.
      this._wheres.push('1 = 0')
      return this
    }
    const list = values.map(v => renderValue(v)).join(', ')
    this._wheres.push(`${quoteIdent(column)} IN (${list})`)
    return this
  }

  /**
   * Appends an ORDER BY term.
   * @param {string} column
   * @param {string} [direction='asc']
   * @returns {ClickHouseQuery}
   */
  orderBy(column, direction = 'asc') {
    const dir = String(direction).toLowerCase() === 'desc' ? 'DESC' : 'ASC'
    this._orderBy.push(`${quoteIdent(column)} ${dir}`)
    return this
  }

  /**
   * Appends GROUP BY columns.
   * @param {...string} cols
   * @returns {ClickHouseQuery}
   */
  groupBy(...cols) {
    this._groupBy.push(...cols.flat().map(c => quoteIdent(c)))
    return this
  }

  /**
   * Sets the row limit.
   * @param {number} n
   * @returns {ClickHouseQuery}
   */
  limit(n) {
    this._limit = Number(n)
    return this
  }

  /**
   * Sets the row offset (requires a limit in ClickHouse).
   * @param {number} n
   * @returns {ClickHouseQuery}
   */
  offset(n) {
    this._offset = Number(n)
    return this
  }

  /**
   * Executes the query and returns the first row, or null when empty.
   * @returns {Promise<object|null>}
   */
  async first() {
    this._limit = 1
    const rows = await this._execute()
    return rows[0] || null
  }

  /**
   * Executes a COUNT over the current WHERE/GROUP state and returns a plain number.
   * @returns {Promise<number>}
   */
  async count() {
    this._isCount = true
    this._columns = ['count() AS count']
    const rows = await this._execute()
    return rows.length > 0 ? Number(Object.values(rows[0])[0]) || 0 : 0
  }

  /**
   * Compiles the builder state into a ClickHouse SQL string.
   * @returns {string}
   */
  toSQL() {
    const parts = [`SELECT ${this._columns.join(', ')}`, `FROM ${quoteIdent(this._table)}`]

    if (this._wheres.length > 0) parts.push(`WHERE ${this._wheres.join(' AND ')}`)
    if (this._groupBy.length > 0) parts.push(`GROUP BY ${this._groupBy.join(', ')}`)
    if (this._orderBy.length > 0) parts.push(`ORDER BY ${this._orderBy.join(', ')}`)
    if (this._limit != null) {
      parts.push(this._offset != null ? `LIMIT ${this._offset}, ${this._limit}` : `LIMIT ${this._limit}`)
    }

    return parts.join(' ')
  }

  /**
   * Thenable execution — awaiting the builder runs the compiled query.
   * @param {function} resolve
   * @param {function} reject
   * @returns {Promise}
   */
  then(resolve, reject) {
    return this._execute().then(resolve, reject)
  }

  /**
   * @param {function} fn
   * @returns {Promise}
   */
  catch(fn) {
    return this._execute().catch(fn)
  }

  /**
   * @returns {Promise<Array<object>>}
   */
  _execute() {
    return this._adapter.query(this.toSQL())
  }

  /**
   * Pushes a single "col op value" (or "col IS [NOT] NULL") condition.
   * @param {string} col
   * @param {string} op
   * @param {*} val
   */
  _pushCondition(col, op, val) {
    if (val === null) {
      this._wheres.push(`${quoteIdent(col)} IS ${op === '!=' || op === '<>' ? 'NOT NULL' : 'NULL'}`)
      return
    }
    this._wheres.push(`${quoteIdent(col)} ${op} ${renderValue(val)}`)
  }
}

/**
 * Renders a scalar value for ClickHouse SQL: numbers bare, booleans as 0/1, everything else quoted.
 * @param {*} value
 * @returns {string}
 */
function renderValue(value) {
  if (typeof value === 'number') return String(value)
  if (typeof value === 'boolean') return value ? '1' : '0'
  return quoteLiteral(value)
}

module.exports = ClickHouseQuery
module.exports.renderValue = renderValue
