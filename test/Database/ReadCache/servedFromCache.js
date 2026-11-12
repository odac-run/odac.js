'use strict'

/**
 * Whether ReadCache answers a query without running it.
 * Why: invalidation is versioned, so superseded entries stay in the store until their TTL;
 * tests assert what a reader observes instead of inspecting keys.
 *
 * @param {string} table - Primary table of the query
 * @param {function} build - Returns a fresh Knex query builder for the query
 * @returns {Promise<boolean>}
 */
module.exports = async function servedFromCache(table, build) {
  const readCache = require('../../../src/Database/ReadCache')
  const qb = build()
  let ran = false
  await readCache.get(
    'default',
    table,
    qb,
    () => {
      ran = true
      return qb.then(rows => rows)
    },
    60
  )
  return !ran
}
