'use strict'
const cluster = require('node:cluster')
const {randomUUID} = require('node:crypto')

/**
 * Write-Behind Cache with Write Coalescing for ODAC Database layer.
 *
 * Why: Individual UPDATE SET col = col + 1 per request is expensive at scale.
 * This module buffers increments (counters) and inserts (queues) in the Primary
 * process's memory, then flushes them to the database in batches.
 *
 * Architecture: Primary-Replica via cluster IPC.
 * - Primary holds the source of truth (deltas, bases, queues).
 * - Workers send requests through cluster IPC with 'wb:' prefix.
 * - LMDB checkpoints protect against data loss on crash.
 *
 * API (exposed via Database.js proxy):
 *   Odac.DB.posts.buffer.increment(where, column, delta?)
 *   Odac.DB.posts.buffer.get(where, column)
 *   Odac.DB.posts.buffer.update(where, data)    — last-write-wins coalescing
 *   Odac.DB.posts.buffer.insert(row)
 *   Odac.DB.posts.buffer.flush()
 *   Odac.DB.buffer.flush()       — global flush
 */

const DEFAULT_CONFIG = {
  flushInterval: 5000,
  checkpointInterval: 30000,
  maxQueueSize: 10000,
  primaryKey: 'id',
  insertBatchSize: 1000
}

class WriteBuffer {
  constructor() {
    /** @type {Map<string, number>} counterKey → accumulated delta */
    this._counters = new Map()
    /** @type {Map<string, number>} counterKey → last known DB value */
    this._bases = new Map()
    /** @type {Map<string, object>} updateKey → merged column values (last-write-wins) */
    this._updates = new Map()
    /** @type {Map<string, Array<object>>} "connection:table" → rows[] */
    this._queues = new Map()
    /** @type {Map<string, {resolve, reject, timeout}>} request tracking for workers */
    this._requests = new Map()

    this._flushTimer = null
    this._checkpointTimer = null
    this._config = {}
    this._initialized = false
    this._flushing = false
  }

  // ─── Lifecycle ──────────────────────────────────────────────

  /**
   * Initializes the WriteBuffer on both Primary and Worker processes.
   * Primary: sets up IPC handler, flush/checkpoint timers, and crash recovery.
   * Worker: sets up IPC response handler.
   */
  async init(connections) {
    if (this._initialized) return
    this._initialized = true

    this._connections = connections
    this._config = {...DEFAULT_CONFIG, ...Odac.Config.buffer}

    if (cluster.isPrimary) {
      await this._recoverFromCheckpoint()
      this._setupPrimaryHandler()
      this._startFlushTimer()
      this._startCheckpointTimer()
    } else {
      this._setupWorkerHandler()
    }
  }

  // ─── Public API (called from workers via proxy) ─────────────

  /**
   * Atomically increments a counter by delta (default 1).
   * Returns the current total (base + accumulated delta).
   *
   * @param {string} connection - Database connection key
   * @param {string} table - Table name
   * @param {number|string|object} where - Row identifier (PK value or composite key)
   * @param {string} column - Column to increment
   * @param {number} [delta=1] - Amount to add
   * @returns {Promise<number>} Current counter value (base + delta)
   */
  async increment(connection, table, where, column, delta = 1) {
    if (cluster.isPrimary) {
      return this._primaryIncrement(connection, table, where, column, delta)
    }
    return this._send('increment', {connection, table, where, column, delta})
  }

  /**
   * Returns the current value of a buffered counter (base + pending delta).
   * If no base value is cached, fetches from DB and caches it.
   *
   * @param {string} connection - Database connection key
   * @param {string} table - Table name
   * @param {number|string|object} where - Row identifier
   * @param {string} column - Column to read
   * @returns {Promise<number>} Current counter value
   */
  async get(connection, table, where, column) {
    if (cluster.isPrimary) {
      return this._primaryGet(connection, table, where, column)
    }
    return this._send('get', {connection, table, where, column})
  }

  /**
   * Buffers column updates for a row using last-write-wins coalescing.
   * Multiple updates to the same row merge into a single UPDATE query at flush.
   *
   * Why: Repeated SET operations (e.g., active_date on every request) collapse
   * into one query per row — 50 requests = 1 UPDATE instead of 50.
   *
   * @param {string} connection - Database connection key
   * @param {string} table - Table name
   * @param {number|string|object} where - Row identifier (PK value or composite key)
   * @param {object} data - Column-value pairs to set (merged with previous pending updates)
   * @returns {Promise<boolean>} true when buffered
   */
  async update(connection, table, where, data) {
    if (cluster.isPrimary) {
      return this._primaryUpdate(connection, table, where, data)
    }
    return this._send('update', {connection, table, where, data})
  }

  /**
   * Buffers a row for batch INSERT. Auto-flushes when maxQueueSize is reached.
   *
   * @param {string} connection - Database connection key
   * @param {string} table - Table name
   * @param {object} row - Row data to insert
   * @returns {Promise<boolean>} true when buffered
   */
  async insert(connection, table, row) {
    if (cluster.isPrimary) {
      return this._primaryInsert(connection, table, row)
    }
    return this._send('insert', {connection, table, row})
  }

  /**
   * Force-flushes all pending data (or a specific table) to the database.
   *
   * @param {string} [connection] - Optional connection key to scope flush
   * @param {string} [table] - Optional table name to scope flush
   * @returns {Promise<void>}
   */
  async flush(connection, table) {
    if (cluster.isPrimary) {
      return this._primaryFlush(connection, table)
    }
    return this._send('flush', {connection, table})
  }

  // ─── Primary: Core Logic ────────────────────────────────────

  _primaryIncrement(connection, table, where, column, delta) {
    const key = this._counterKey(connection, table, where, column)
    const current = this._counters.get(key) || 0
    this._counters.set(key, current + delta)

    // Return base + new delta for caller
    const base = this._bases.get(key)
    if (base != null) {
      return base + current + delta
    }

    // No base cached — fetch from DB, then return base + delta
    return this._fetchBase(connection, table, where, column).then(dbValue => {
      return dbValue + current + delta
    })
  }

  async _primaryGet(connection, table, where, column) {
    const key = this._counterKey(connection, table, where, column)
    const delta = this._counters.get(key) || 0

    const base = this._bases.get(key)
    if (base != null) return base + delta

    const dbValue = await this._fetchBase(connection, table, where, column)
    return dbValue + delta
  }

  _primaryUpdate(connection, table, where, data) {
    const key = this._updateKey(connection, table, where)
    const existing = this._updates.get(key) || {}
    // Merge: new columns overwrite old ones (last-write-wins)
    this._updates.set(key, {...existing, ...data})
    return true
  }

  _primaryInsert(connection, table, row) {
    const queueKey = `${connection}:${table}`
    let queue = this._queues.get(queueKey)
    if (!queue) {
      queue = []
      this._queues.set(queueKey, queue)
    }
    queue.push(row)

    // Auto-flush when queue exceeds threshold
    if (queue.length >= this._config.maxQueueSize) {
      this._flushQueues(connection, table)
    }

    return true
  }

  async _primaryFlush(connection, table) {
    if (this._flushing) return
    this._flushing = true
    try {
      await this._flushCounters(connection, table)
      await this._flushUpdates(connection, table)
      await this._flushQueues(connection, table)
      this._clearCheckpoint(connection, table)
    } finally {
      this._flushing = false
    }
  }

  // ─── Primary: Flush Logic ──────────────────────────────────

  async _flushCounters(filterConnection, filterTable) {
    if (this._counters.size === 0) return

    // Group deltas by connection+table
    const grouped = new Map()

    for (const [key, delta] of this._counters) {
      if (delta === 0) continue

      const parsed = this._parseCounterKey(key)
      if (!parsed) continue
      if (filterConnection && parsed.connection !== filterConnection) continue
      if (filterTable && parsed.table !== filterTable) continue

      const groupKey = `${parsed.connection}:${parsed.table}`
      if (!grouped.has(groupKey)) {
        grouped.set(groupKey, {connection: parsed.connection, table: parsed.table, entries: []})
      }
      grouped.get(groupKey).entries.push({key, where: parsed.where, column: parsed.column, delta})
    }

    for (const [, group] of grouped) {
      const knex = this._connections[group.connection]
      if (!knex) continue

      try {
        await knex.transaction(async trx => {
          for (const entry of group.entries) {
            const whereClause = this._normalizeWhere(entry.where)
            await trx(group.table)
              .where(whereClause)
              .update({
                [entry.column]: trx.raw(`?? + ?`, [entry.column, entry.delta])
              })

            // Update base: base += delta, reset counter
            const currentBase = this._bases.get(entry.key) || 0
            this._bases.set(entry.key, currentBase + entry.delta)
            this._counters.set(entry.key, 0)
          }
        })

        // Only delete flushed counters after successful commit
        for (const entry of group.entries) {
          if (this._counters.get(entry.key) === 0) {
            this._counters.delete(entry.key)
          }
        }
      } catch (err) {
        // Keep deltas on failure — will retry next cycle
        console.error(`\x1b[31m[WriteBuffer]\x1b[0m Counter flush failed for ${group.table}:`, err.message)
      }
    }
  }

  async _flushUpdates(filterConnection, filterTable) {
    if (this._updates.size === 0) return

    // Group by connection+table for transaction batching
    const grouped = new Map()

    for (const [key, data] of this._updates) {
      const parsed = this._parseUpdateKey(key)
      if (!parsed) continue
      if (filterConnection && parsed.connection !== filterConnection) continue
      if (filterTable && parsed.table !== filterTable) continue

      const groupKey = `${parsed.connection}:${parsed.table}`
      if (!grouped.has(groupKey)) {
        grouped.set(groupKey, {connection: parsed.connection, table: parsed.table, entries: []})
      }
      grouped.get(groupKey).entries.push({key, where: parsed.where, data})
    }

    for (const [, group] of grouped) {
      const knex = this._connections[group.connection]
      if (!knex) continue

      try {
        await knex.transaction(async trx => {
          for (const entry of group.entries) {
            const whereClause = this._normalizeWhere(entry.where)
            await trx(group.table).where(whereClause).update(entry.data)
          }
        })

        // Clear flushed entries
        for (const entry of group.entries) {
          this._updates.delete(entry.key)
        }
      } catch (err) {
        // Keep updates on failure — will retry next cycle
        console.error(`\x1b[31m[WriteBuffer]\x1b[0m Update flush failed for ${group.table}:`, err.message)
      }
    }
  }

  async _flushQueues(filterConnection, filterTable) {
    for (const [queueKey, queue] of this._queues) {
      if (queue.length === 0) continue

      const [connection, table] = queueKey.split(':')
      if (filterConnection && connection !== filterConnection) continue
      if (filterTable && table !== filterTable) continue

      const knex = this._connections[connection]
      if (!knex) continue

      // Atomic swap — grab all rows, clear queue immediately
      const rows = queue.splice(0)

      try {
        // Chunk to prevent oversized queries
        for (let i = 0; i < rows.length; i += this._config.insertBatchSize) {
          const chunk = rows.slice(i, i + this._config.insertBatchSize)
          await knex(table).insert(chunk)
        }
      } catch (err) {
        // Re-queue failed rows at front for next flush
        const current = this._queues.get(queueKey) || []
        this._queues.set(queueKey, rows.concat(current))
        console.error(`\x1b[31m[WriteBuffer]\x1b[0m Queue flush failed for ${table}:`, err.message)
      }
    }
  }

  // ─── Primary: DB Base Fetch ────────────────────────────────

  async _fetchBase(connection, table, where, column) {
    const key = this._counterKey(connection, table, where, column)

    // Prevent concurrent fetches for the same key
    if (this._bases.has(key)) return this._bases.get(key)

    const knex = this._connections[connection]
    if (!knex) {
      this._bases.set(key, 0)
      return 0
    }

    try {
      const whereClause = this._normalizeWhere(where)
      const row = await knex(table).where(whereClause).select(column).first()
      const value = row ? Number(row[column]) || 0 : 0
      this._bases.set(key, value)
      return value
    } catch (err) {
      console.error(`\x1b[31m[WriteBuffer]\x1b[0m Base fetch failed for ${table}.${column}:`, err.message)
      this._bases.set(key, 0)
      return 0
    }
  }

  // ─── Primary: LMDB Checkpoint ──────────────────────────────

  _writeCheckpoint() {
    if (!Odac.Storage?.isReady()) return

    // Counters
    for (const [key, delta] of this._counters) {
      if (delta === 0) continue
      const base = this._bases.get(key) || 0
      Odac.Storage.put(`wb:c:${key}`, {delta, base})
    }

    // Updates
    for (const [key, data] of this._updates) {
      if (Object.keys(data).length === 0) continue
      Odac.Storage.put(`wb:u:${key}`, data)
    }

    // Queues
    for (const [queueKey, rows] of this._queues) {
      if (rows.length === 0) continue
      Odac.Storage.put(`wb:q:${queueKey}`, rows)
    }
  }

  _clearCheckpoint(filterConnection, filterTable) {
    if (!Odac.Storage?.isReady()) return

    // Clear counters
    for (const {key} of Odac.Storage.getRange({start: 'wb:c:', end: 'wb:c:~'})) {
      if (filterConnection || filterTable) {
        const parsed = this._parseCounterKey(key.slice(5)) // Strip 'wb:c:' prefix
        if (parsed && filterConnection && parsed.connection !== filterConnection) continue
        if (parsed && filterTable && parsed.table !== filterTable) continue
      }
      Odac.Storage.remove(key)
    }

    // Clear updates
    for (const {key} of Odac.Storage.getRange({start: 'wb:u:', end: 'wb:u:~'})) {
      if (filterConnection || filterTable) {
        const parsed = this._parseUpdateKey(key.slice(5)) // Strip 'wb:u:' prefix
        if (parsed && filterConnection && parsed.connection !== filterConnection) continue
        if (parsed && filterTable && parsed.table !== filterTable) continue
      }
      Odac.Storage.remove(key)
    }

    // Clear queues
    for (const {key} of Odac.Storage.getRange({start: 'wb:q:', end: 'wb:q:~'})) {
      if (filterConnection || filterTable) {
        const queueMeta = key.slice(5) // Strip 'wb:q:' prefix
        const [conn, tbl] = queueMeta.split(':')
        if (filterConnection && conn !== filterConnection) continue
        if (filterTable && tbl !== filterTable) continue
      }
      Odac.Storage.remove(key)
    }
  }

  async _recoverFromCheckpoint() {
    if (!Odac.Storage?.isReady()) return

    let counterCount = 0
    let queueCount = 0

    // Recover counters
    for (const {key, value} of Odac.Storage.getRange({start: 'wb:c:', end: 'wb:c:~'})) {
      if (!value || typeof value.delta !== 'number') continue
      const counterKey = key.slice(5) // Strip 'wb:c:' prefix
      this._counters.set(counterKey, (this._counters.get(counterKey) || 0) + value.delta)
      if (value.base != null) this._bases.set(counterKey, value.base)
      counterCount++
    }

    // Recover updates
    let updateCount = 0
    for (const {key, value} of Odac.Storage.getRange({start: 'wb:u:', end: 'wb:u:~'})) {
      if (!value || typeof value !== 'object') continue
      const updateKey = key.slice(5) // Strip 'wb:u:' prefix
      const existing = this._updates.get(updateKey) || {}
      this._updates.set(updateKey, {...value, ...existing})
      updateCount++
    }

    // Recover queues
    for (const {key, value} of Odac.Storage.getRange({start: 'wb:q:', end: 'wb:q:~'})) {
      if (!Array.isArray(value)) continue
      const queueKey = key.slice(5) // Strip 'wb:q:' prefix
      const existing = this._queues.get(queueKey) || []
      this._queues.set(queueKey, value.concat(existing))
      queueCount++
    }

    if (counterCount > 0 || updateCount > 0 || queueCount > 0) {
      console.log(
        `\x1b[36m[WriteBuffer]\x1b[0m Recovered from checkpoint: ${counterCount} counters, ${updateCount} updates, ${queueCount} queues.`
      )
    }
  }

  // ─── Cluster IPC ───────────────────────────────────────────

  _setupPrimaryHandler() {
    if (global.__odac_wb_message_handler) {
      cluster.removeListener('message', global.__odac_wb_message_handler)
    }

    const handler = (worker, msg) => {
      if (!msg || !msg.type || !msg.type.startsWith('wb:')) return
      this._handlePrimaryMessage(worker, msg)
    }

    global.__odac_wb_message_handler = handler
    cluster.on('message', handler)
  }

  async _handlePrimaryMessage(worker, msg) {
    const action = msg.type.slice(3) // Strip 'wb:' prefix
    let response = null

    try {
      switch (action) {
        case 'increment':
          response = await this._primaryIncrement(msg.connection, msg.table, msg.where, msg.column, msg.delta)
          break
        case 'get':
          response = await this._primaryGet(msg.connection, msg.table, msg.where, msg.column)
          break
        case 'update':
          response = this._primaryUpdate(msg.connection, msg.table, msg.where, msg.data)
          break
        case 'insert':
          response = this._primaryInsert(msg.connection, msg.table, msg.row)
          break
        case 'flush':
          await this._primaryFlush(msg.connection, msg.table)
          response = true
          break
      }
    } catch (err) {
      console.error(`\x1b[31m[WriteBuffer]\x1b[0m Primary handler error (${action}):`, err.message)
      if (msg.id && worker.isConnected()) {
        worker.send({type: 'wb:response', id: msg.id, error: err.message})
      }
      return
    }

    if (msg.id && worker.isConnected()) {
      worker.send({type: 'wb:response', id: msg.id, data: response})
    }
  }

  _setupWorkerHandler() {
    process.on('message', msg => {
      if (!msg || msg.type !== 'wb:response') return

      const req = this._requests.get(msg.id)
      if (!req) return

      clearTimeout(req.timeout)
      this._requests.delete(msg.id)

      if (msg.error) {
        req.reject(new Error(msg.error))
      } else {
        req.resolve(msg.data)
      }
    })
  }

  _send(action, payload) {
    if (cluster.isPrimary) {
      // Direct call when used from primary (rare but possible)
      switch (action) {
        case 'increment':
          return Promise.resolve(this._primaryIncrement(payload.connection, payload.table, payload.where, payload.column, payload.delta))
        case 'get':
          return this._primaryGet(payload.connection, payload.table, payload.where, payload.column)
        case 'update':
          return Promise.resolve(this._primaryUpdate(payload.connection, payload.table, payload.where, payload.data))
        case 'insert':
          return Promise.resolve(this._primaryInsert(payload.connection, payload.table, payload.row))
        case 'flush':
          return this._primaryFlush(payload.connection, payload.table)
      }
    }

    return new Promise((resolve, reject) => {
      const id = randomUUID()
      const timeout = setTimeout(() => {
        if (this._requests.has(id)) {
          this._requests.delete(id)
          reject(new Error(`WriteBuffer request timed out: ${action}`))
        }
      }, 10000)

      this._requests.set(id, {resolve, reject, timeout})
      process.send({type: `wb:${action}`, id, ...payload})
    })
  }

  // ─── Timers ────────────────────────────────────────────────

  _startFlushTimer() {
    if (this._flushTimer) clearInterval(this._flushTimer)

    this._flushTimer = setInterval(async () => {
      try {
        await this._primaryFlush()
      } catch (err) {
        console.error('\x1b[31m[WriteBuffer]\x1b[0m Periodic flush error:', err.message)
      }
    }, this._config.flushInterval)

    this._flushTimer.unref()
  }

  _startCheckpointTimer() {
    if (this._checkpointTimer) clearInterval(this._checkpointTimer)

    this._checkpointTimer = setInterval(() => {
      try {
        this._writeCheckpoint()
      } catch (err) {
        console.error('\x1b[31m[WriteBuffer]\x1b[0m Checkpoint error:', err.message)
      }
    }, this._config.checkpointInterval)

    this._checkpointTimer.unref()
  }

  // ─── Key Utilities ─────────────────────────────────────────

  /**
   * Builds a deterministic cache key for a counter.
   * Format: "connection:table:serializedWhere:column"
   */
  _counterKey(connection, table, where, column) {
    const whereStr = typeof where === 'object' ? JSON.stringify(this._sortedObject(where)) : String(where)
    return `${connection}:${table}:${whereStr}:${column}`
  }

  /**
   * Builds a deterministic cache key for an update.
   * Format: "connection:table:serializedWhere"
   */
  _updateKey(connection, table, where) {
    const whereStr = typeof where === 'object' ? JSON.stringify(this._sortedObject(where)) : String(where)
    return `${connection}:${table}:${whereStr}`
  }

  _parseUpdateKey(key) {
    // Format: "connection:table:where"
    const firstColon = key.indexOf(':')
    if (firstColon === -1) return null
    const connection = key.slice(0, firstColon)

    const secondColon = key.indexOf(':', firstColon + 1)
    if (secondColon === -1) return null
    const table = key.slice(firstColon + 1, secondColon)

    const where = key.slice(secondColon + 1)
    return {connection, table, where}
  }

  _parseCounterKey(key) {
    // Format: "connection:table:where:column"
    // where may contain ':' if it's a JSON string, so we split carefully
    const firstColon = key.indexOf(':')
    if (firstColon === -1) return null
    const connection = key.slice(0, firstColon)

    const secondColon = key.indexOf(':', firstColon + 1)
    if (secondColon === -1) return null
    const table = key.slice(firstColon + 1, secondColon)

    const lastColon = key.lastIndexOf(':')
    if (lastColon <= secondColon) return null
    const column = key.slice(lastColon + 1)

    const where = key.slice(secondColon + 1, lastColon)
    return {connection, table, where, column}
  }

  /**
   * Normalizes a where identifier into a Knex-compatible object.
   * - JSON string (from key parsing): parsed back to object
   * - Object: used directly as-is
   * - Scalar (number/string): uses configured primaryKey → {id: value}
   */
  _normalizeWhere(where) {
    if (typeof where === 'object' && where !== null) return where
    if (typeof where === 'string' && where.startsWith('{')) {
      try {
        return JSON.parse(where)
      } catch {
        // Not valid JSON — treat as scalar
      }
    }
    return {[this._config.primaryKey]: where}
  }

  _sortedObject(obj) {
    const sorted = {}
    for (const key of Object.keys(obj).sort()) {
      sorted[key] = obj[key]
    }
    return sorted
  }

  // ─── Teardown ──────────────────────────────────────────────

  /**
   * Graceful shutdown: flush all pending data → clear checkpoint → stop timers.
   * Called from Server.js before Database.close() to ensure no data loss.
   */
  async close() {
    if (this._flushTimer) {
      clearInterval(this._flushTimer)
      this._flushTimer = null
    }
    if (this._checkpointTimer) {
      clearInterval(this._checkpointTimer)
      this._checkpointTimer = null
    }

    if (cluster.isPrimary) {
      // Final flush — write all pending data to DB
      try {
        await this._primaryFlush()
        console.log('\x1b[32m[WriteBuffer]\x1b[0m Final flush completed.')
      } catch (err) {
        console.error('\x1b[31m[WriteBuffer]\x1b[0m Final flush failed:', err.message)
        // Last resort: checkpoint to LMDB so data survives restart
        this._writeCheckpoint()
      }

      if (global.__odac_wb_message_handler) {
        cluster.removeListener('message', global.__odac_wb_message_handler)
        global.__odac_wb_message_handler = null
      }

      this._counters.clear()
      this._bases.clear()
      this._updates.clear()
      this._queues.clear()
    } else {
      // Worker: reject pending requests
      for (const req of this._requests.values()) {
        clearTimeout(req.timeout)
        req.reject(new Error('WriteBuffer shutting down'))
      }
      this._requests.clear()
    }

    this._initialized = false
  }
}

module.exports = new WriteBuffer()
