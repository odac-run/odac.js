'use strict'
const cluster = require('node:cluster')

/**
 * Write-Behind Cache with Write Coalescing for ODAC Database layer.
 *
 * Why: Individual UPDATE SET col = col + 1 per request is expensive at scale.
 * This module buffers increments (counters), updates (last-write-wins), and inserts (queues)
 * via the Ipc layer, then flushes them to the database in batches.
 *
 * Architecture: Fully delegated to Odac.Ipc for state management.
 * - Memory driver: Primary process holds state in Maps via cluster IPC (single machine).
 * - Redis driver: All state lives in Redis — works across horizontal load balancers.
 * - On both drivers, the API is identical and WriteBuffer is driver-agnostic.
 * - Distributed lock (Ipc.lock) ensures only one process flushes at a time.
 * - LMDB checkpoints (memory driver only) protect against crash data loss.
 *
 * Key namespaces in Ipc:
 *   wb:c:{connection}:{table}:{where}:{column} — counter delta (number via incrBy)
 *   wb:b:{connection}:{table}:{where}:{column} — counter base from DB (number via set)
 *   wb:u:{connection}:{table}:{where}          — update fields (hash via hset)
 *   wb:q:{connection}:{table}                  — insert queue (list via rpush)
 *   wb:idx:counters                            — set of active counter keys
 *   wb:idx:updates                             — set of active update keys
 *   wb:idx:queues                              — set of active queue keys
 *   wb:lock:flush                              — distributed flush lock
 *
 * API (exposed via Database.js proxy):
 *   Odac.DB.posts.buffer.where(id).increment('views', 5)
 *   Odac.DB.posts.buffer.where(id).get('views')
 *   Odac.DB.posts.buffer.where(id).update({active_date: new Date()})
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
    this._flushTimer = null
    this._checkpointTimer = null
    this._config = {}
    this._initialized = false
  }

  // ─── Lifecycle ──────────────────────────────────────────────

  /**
   * Why: Initializes the WriteBuffer. Called from Database.init() after Ipc is ready.
   * Primary: recovers LMDB checkpoint, starts flush/checkpoint timers.
   * All processes: stores connection references for flush DB writes.
   */
  async init(connections) {
    if (this._initialized) return
    this._initialized = true

    this._connections = connections
    this._config = {...DEFAULT_CONFIG, ...Odac.Config.buffer}

    if (cluster.isPrimary) {
      await this._recoverFromCheckpoint()
      this._startFlushTimer()
      this._startCheckpointTimer()
    }
  }

  // ─── Public API ─────────────────────────────────────────────

  /**
   * Atomically increments a counter by delta (default 1).
   * Returns the current total (base + accumulated delta).
   *
   * Why: Uses Ipc.incrBy for atomic delta accumulation — safe across workers AND servers.
   * Base is fetched from DB once and cached in Ipc for subsequent reads.
   */
  async increment(connection, table, where, column, delta = 1) {
    const key = this._counterKey(connection, table, where, column)

    // Atomic increment — returns new total delta
    const totalDelta = await Odac.Ipc.incrBy(`wb:c:${key}`, delta)

    // Track this key in the counter index for flush discovery
    await Odac.Ipc.sadd('wb:idx:counters', key)

    // Fetch or read cached base from DB
    const base = await this._fetchBase(connection, table, where, column)
    return base + totalDelta
  }

  /**
   * Returns the current value of a buffered counter (base + pending delta).
   *
   * Why: Reads from Ipc — returns accurate value even in horizontal scaling (Redis driver).
   * For memory driver, reads from Primary's store via cluster IPC.
   */
  async get(connection, table, where, column) {
    const key = this._counterKey(connection, table, where, column)
    const totalDelta = (await Odac.Ipc.get(`wb:c:${key}`)) || 0
    const base = await this._fetchBase(connection, table, where, column)
    return base + totalDelta
  }

  /**
   * Buffers column updates for a row using last-write-wins coalescing.
   *
   * Why: Ipc.hset merges fields atomically — multiple workers updating different columns
   * on the same row collapse into a single UPDATE query at flush time.
   */
  async update(connection, table, where, data) {
    const key = this._updateKey(connection, table, where)
    await Odac.Ipc.hset(`wb:u:${key}`, data)
    await Odac.Ipc.sadd('wb:idx:updates', key)
    return true
  }

  /**
   * Buffers a row for batch INSERT. Auto-flushes when maxQueueSize is reached.
   *
   * Why: Ipc.rpush appends to a shared list — multiple workers/servers contribute rows
   * that are drained to the database in a single INSERT batch.
   */
  async insert(connection, table, row) {
    const queueKey = `${connection}:${table}`
    const length = await Odac.Ipc.rpush(`wb:q:${queueKey}`, row)
    await Odac.Ipc.sadd('wb:idx:queues', queueKey)

    // Auto-flush when queue exceeds threshold
    if (length >= this._config.maxQueueSize) {
      this._flushQueues(connection, table)
    }

    return true
  }

  /**
   * Force-flushes all pending data (or a specific table) to the database.
   *
   * Why: Distributed lock ensures exactly one process flushes at a time,
   * preventing duplicate writes in horizontal scaling scenarios.
   */
  async flush(connection, table) {
    const acquired = await Odac.Ipc.lock('wb:lock:flush', 10)
    if (!acquired) return

    try {
      await this._flushCounters(connection, table)
      await this._flushUpdates(connection, table)
      await this._flushQueues(connection, table)
      this._clearCheckpoint(connection, table)
    } finally {
      await Odac.Ipc.unlock('wb:lock:flush')
    }
  }

  // ─── Flush Logic ───────────────────────────────────────────

  async _flushCounters(filterConnection, filterTable) {
    const keys = await Odac.Ipc.smembers('wb:idx:counters')
    if (keys.length === 0) return

    // Group by connection+table for transaction batching
    const grouped = new Map()

    for (const key of keys) {
      const parsed = this._parseCounterKey(key)
      if (!parsed) continue
      if (filterConnection && parsed.connection !== filterConnection) continue
      if (filterTable && parsed.table !== filterTable) continue

      const groupKey = `${parsed.connection}:${parsed.table}`
      if (!grouped.has(groupKey)) {
        grouped.set(groupKey, {connection: parsed.connection, table: parsed.table, entries: []})
      }
      grouped.get(groupKey).entries.push({key, ...parsed})
    }

    for (const [, group] of grouped) {
      const knex = this._connections[group.connection]
      if (!knex) continue

      try {
        // Read all deltas for this group BEFORE the transaction
        const deltas = new Map()
        for (const entry of group.entries) {
          const delta = (await Odac.Ipc.get(`wb:c:${entry.key}`)) || 0
          if (delta !== 0) deltas.set(entry.key, {delta, ...entry})
        }

        if (deltas.size === 0) continue

        await knex.transaction(async trx => {
          for (const [, entry] of deltas) {
            const whereClause = this._normalizeWhere(entry.where)
            await trx(group.table)
              .where(whereClause)
              .update({
                [entry.column]: trx.raw(`?? + ?`, [entry.column, entry.delta])
              })
          }
        })

        // After successful commit: subtract flushed deltas, update bases
        for (const [entryKey, entry] of deltas) {
          await Odac.Ipc.decrBy(`wb:c:${entryKey}`, entry.delta)

          // Update cached base: base += flushed delta
          const baseKey = `wb:b:${entryKey}`
          const currentBase = (await Odac.Ipc.get(baseKey)) || 0
          await Odac.Ipc.set(baseKey, currentBase + entry.delta)

          // If counter is now 0, clean up
          const remaining = (await Odac.Ipc.get(`wb:c:${entryKey}`)) || 0
          if (remaining === 0) {
            await Odac.Ipc.del(`wb:c:${entryKey}`)
            await Odac.Ipc.srem('wb:idx:counters', entryKey)
          }
        }
      } catch (err) {
        // Keep deltas in Ipc on failure — will retry next cycle
        console.error(`\x1b[31m[WriteBuffer]\x1b[0m Counter flush failed for ${group.table}:`, err.message)
      }
    }
  }

  async _flushUpdates(filterConnection, filterTable) {
    const keys = await Odac.Ipc.smembers('wb:idx:updates')
    if (keys.length === 0) return

    const grouped = new Map()

    for (const key of keys) {
      const parsed = this._parseUpdateKey(key)
      if (!parsed) continue
      if (filterConnection && parsed.connection !== filterConnection) continue
      if (filterTable && parsed.table !== filterTable) continue

      const groupKey = `${parsed.connection}:${parsed.table}`
      if (!grouped.has(groupKey)) {
        grouped.set(groupKey, {connection: parsed.connection, table: parsed.table, entries: []})
      }
      grouped.get(groupKey).entries.push({key, ...parsed})
    }

    for (const [, group] of grouped) {
      const knex = this._connections[group.connection]
      if (!knex) continue

      try {
        // Read all pending update hashes
        const updates = new Map()
        for (const entry of group.entries) {
          const data = await Odac.Ipc.hgetall(`wb:u:${entry.key}`)
          if (data && Object.keys(data).length > 0) {
            updates.set(entry.key, {data, ...entry})
          }
        }

        if (updates.size === 0) continue

        await knex.transaction(async trx => {
          for (const [, entry] of updates) {
            const whereClause = this._normalizeWhere(entry.where)
            await trx(group.table).where(whereClause).update(entry.data)
          }
        })

        // After successful commit: clear flushed update hashes
        for (const [entryKey] of updates) {
          await Odac.Ipc.del(`wb:u:${entryKey}`)
          await Odac.Ipc.srem('wb:idx:updates', entryKey)
        }
      } catch (err) {
        console.error(`\x1b[31m[WriteBuffer]\x1b[0m Update flush failed for ${group.table}:`, err.message)
      }
    }
  }

  async _flushQueues(filterConnection, filterTable) {
    const queueKeys = await Odac.Ipc.smembers('wb:idx:queues')
    if (queueKeys.length === 0) return

    for (const queueKey of queueKeys) {
      const [connection, table] = queueKey.split(':')
      if (filterConnection && connection !== filterConnection) continue
      if (filterTable && table !== filterTable) continue

      const knex = this._connections[connection]
      if (!knex) continue

      // Atomically read all rows and clear the list
      const rows = await Odac.Ipc.lrange(`wb:q:${queueKey}`, 0, -1)
      if (rows.length === 0) continue

      // Clear immediately — new inserts arriving during flush go to a fresh list
      await Odac.Ipc.del(`wb:q:${queueKey}`)

      try {
        for (let i = 0; i < rows.length; i += this._config.insertBatchSize) {
          const chunk = rows.slice(i, i + this._config.insertBatchSize)
          await knex(table).insert(chunk)
        }

        // Clean up index after successful insert
        await Odac.Ipc.srem('wb:idx:queues', queueKey)
      } catch (err) {
        // Re-queue failed rows by pushing them back
        for (const row of rows) {
          await Odac.Ipc.rpush(`wb:q:${queueKey}`, row)
        }
        console.error(`\x1b[31m[WriteBuffer]\x1b[0m Queue flush failed for ${table}:`, err.message)
      }
    }
  }

  // ─── DB Base Fetch ─────────────────────────────────────────

  /**
   * Why: Fetches the current DB value for a counter column and caches it in Ipc.
   * Subsequent reads use the cached base — no DB query per get()/increment().
   * Cache is invalidated after flush (base += flushed delta).
   */
  async _fetchBase(connection, table, where, column) {
    const key = this._counterKey(connection, table, where, column)
    const baseKey = `wb:b:${key}`

    const cached = await Odac.Ipc.get(baseKey)
    if (cached != null) return cached

    const knex = this._connections[connection]
    if (!knex) {
      await Odac.Ipc.set(baseKey, 0)
      return 0
    }

    try {
      const whereClause = this._normalizeWhere(where)
      const row = await knex(table).where(whereClause).select(column).first()
      const value = row ? Number(row[column]) || 0 : 0
      await Odac.Ipc.set(baseKey, value)
      return value
    } catch (err) {
      console.error(`\x1b[31m[WriteBuffer]\x1b[0m Base fetch failed for ${table}.${column}:`, err.message)
      await Odac.Ipc.set(baseKey, 0)
      return 0
    }
  }

  // ─── LMDB Checkpoint (Memory Driver Only) ──────────────────

  /**
   * Why: When Ipc uses memory driver, all state lives in the Primary's RAM.
   * A crash loses everything. Periodic LMDB checkpoint provides crash safety.
   * Skipped when Ipc uses Redis — Redis itself is the persistent store.
   */
  async _writeCheckpoint() {
    if (Odac.Ipc?.config?.driver === 'redis') return
    if (!Odac.Storage?.isReady()) return

    // Counters
    const counterKeys = await Odac.Ipc.smembers('wb:idx:counters')
    for (const key of counterKeys) {
      const delta = (await Odac.Ipc.get(`wb:c:${key}`)) || 0
      if (delta === 0) continue
      const base = (await Odac.Ipc.get(`wb:b:${key}`)) || 0
      Odac.Storage.put(`wb:c:${key}`, {delta, base})
    }

    // Updates
    const updateKeys = await Odac.Ipc.smembers('wb:idx:updates')
    for (const key of updateKeys) {
      const data = await Odac.Ipc.hgetall(`wb:u:${key}`)
      if (data && Object.keys(data).length > 0) {
        Odac.Storage.put(`wb:u:${key}`, data)
      }
    }

    // Queues
    const queueKeys = await Odac.Ipc.smembers('wb:idx:queues')
    for (const key of queueKeys) {
      const rows = await Odac.Ipc.lrange(`wb:q:${key}`, 0, -1)
      if (rows.length > 0) {
        Odac.Storage.put(`wb:q:${key}`, rows)
      }
    }
  }

  _clearCheckpoint(filterConnection, filterTable) {
    if (Odac.Ipc?.config?.driver === 'redis') return
    if (!Odac.Storage?.isReady()) return

    for (const {key} of Odac.Storage.getRange({start: 'wb:c:', end: 'wb:c:~'})) {
      if (filterConnection || filterTable) {
        const parsed = this._parseCounterKey(key.slice(5))
        if (parsed && filterConnection && parsed.connection !== filterConnection) continue
        if (parsed && filterTable && parsed.table !== filterTable) continue
      }
      Odac.Storage.remove(key)
    }

    for (const {key} of Odac.Storage.getRange({start: 'wb:u:', end: 'wb:u:~'})) {
      if (filterConnection || filterTable) {
        const parsed = this._parseUpdateKey(key.slice(5))
        if (parsed && filterConnection && parsed.connection !== filterConnection) continue
        if (parsed && filterTable && parsed.table !== filterTable) continue
      }
      Odac.Storage.remove(key)
    }

    for (const {key} of Odac.Storage.getRange({start: 'wb:q:', end: 'wb:q:~'})) {
      if (filterConnection || filterTable) {
        const queueMeta = key.slice(5)
        const [conn, tbl] = queueMeta.split(':')
        if (filterConnection && conn !== filterConnection) continue
        if (filterTable && tbl !== filterTable) continue
      }
      Odac.Storage.remove(key)
    }
  }

  /**
   * Why: On startup, recover any buffered data that was checkpointed before a crash.
   * Writes recovered data back into Ipc so it will be flushed in the next cycle.
   * Memory driver only — Redis state survives crashes natively.
   */
  async _recoverFromCheckpoint() {
    if (Odac.Ipc?.config?.driver === 'redis') return
    if (!Odac.Storage?.isReady()) return

    let counterCount = 0
    let updateCount = 0
    let queueCount = 0

    // Recover counters
    for (const {key, value} of Odac.Storage.getRange({start: 'wb:c:', end: 'wb:c:~'})) {
      if (!value || typeof value.delta !== 'number') continue
      const counterKey = key.slice(5) // Strip 'wb:c:' prefix
      await Odac.Ipc.incrBy(`wb:c:${counterKey}`, value.delta)
      if (value.base != null) await Odac.Ipc.set(`wb:b:${counterKey}`, value.base)
      await Odac.Ipc.sadd('wb:idx:counters', counterKey)
      counterCount++
    }

    // Recover updates
    for (const {key, value} of Odac.Storage.getRange({start: 'wb:u:', end: 'wb:u:~'})) {
      if (!value || typeof value !== 'object') continue
      const updateKey = key.slice(5)
      await Odac.Ipc.hset(`wb:u:${updateKey}`, value)
      await Odac.Ipc.sadd('wb:idx:updates', updateKey)
      updateCount++
    }

    // Recover queues
    for (const {key, value} of Odac.Storage.getRange({start: 'wb:q:', end: 'wb:q:~'})) {
      if (!Array.isArray(value)) continue
      const queueKey = key.slice(5)
      for (const row of value) {
        await Odac.Ipc.rpush(`wb:q:${queueKey}`, row)
      }
      await Odac.Ipc.sadd('wb:idx:queues', queueKey)
      queueCount++
    }

    if (counterCount > 0 || updateCount > 0 || queueCount > 0) {
      console.log(
        `\x1b[36m[WriteBuffer]\x1b[0m Recovered from checkpoint: ${counterCount} counters, ${updateCount} updates, ${queueCount} queues.`
      )
    }
  }

  // ─── Timers ────────────────────────────────────────────────

  _startFlushTimer() {
    if (this._flushTimer) clearInterval(this._flushTimer)

    this._flushTimer = setInterval(async () => {
      try {
        await this.flush()
      } catch (err) {
        console.error('\x1b[31m[WriteBuffer]\x1b[0m Periodic flush error:', err.message)
      }
    }, this._config.flushInterval)

    this._flushTimer.unref()
  }

  _startCheckpointTimer() {
    if (this._checkpointTimer) clearInterval(this._checkpointTimer)

    this._checkpointTimer = setInterval(async () => {
      try {
        await this._writeCheckpoint()
      } catch (err) {
        console.error('\x1b[31m[WriteBuffer]\x1b[0m Checkpoint error:', err.message)
      }
    }, this._config.checkpointInterval)

    this._checkpointTimer.unref()
  }

  // ─── Key Utilities ─────────────────────────────────────────

  _counterKey(connection, table, where, column) {
    const whereStr = typeof where === 'object' ? JSON.stringify(this._sortedObject(where)) : String(where)
    return `${connection}:${table}:${whereStr}:${column}`
  }

  _updateKey(connection, table, where) {
    const whereStr = typeof where === 'object' ? JSON.stringify(this._sortedObject(where)) : String(where)
    return `${connection}:${table}:${whereStr}`
  }

  _parseUpdateKey(key) {
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
   * Why: Graceful shutdown — flush all pending data, clear checkpoints, stop timers.
   * Final flush writes everything to DB. If that fails, LMDB checkpoint preserves data.
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
      try {
        // Force-acquire lock for final flush (bypass distributed lock)
        await Odac.Ipc.unlock('wb:lock:flush')
        await this.flush()
        console.log('\x1b[32m[WriteBuffer]\x1b[0m Final flush completed.')
      } catch (err) {
        console.error('\x1b[31m[WriteBuffer]\x1b[0m Final flush failed:', err.message)
        try {
          await this._writeCheckpoint()
        } catch {
          // Last resort failed — data may be lost
        }
      }
    }

    this._initialized = false
  }
}

module.exports = new WriteBuffer()
