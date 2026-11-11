'use strict'
const cluster = require('node:cluster')
const nanoid = require('./nanoid')

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
 *   wb:dlq:{connection}:{table}                — rows that kept failing to insert (dead letters)
 *   wb:idx:counters                            — set of active counter keys
 *   wb:idx:updates                             — set of active update keys
 *   wb:idx:queues                              — set of active queue keys
 *   wb:idx:dlq                                 — set of queue keys with dead letters
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
  // Defaults to half the flush interval (see init) so every flush window is checkpointed.
  checkpointInterval: null,
  maxQueueSize: 10000,
  // Hard cap on queued rows per table; defaults to 10 × maxQueueSize (see init). Past it,
  // inserts go straight to the database. 0 disables the cap.
  maxQueueLength: null,
  primaryKey: 'id',
  insertBatchSize: 1000,
  // Flush cycles a row may fail on its own (while the database is reachable) before it is
  // moved to the dead-letter list instead of blocking its queue.
  maxInsertAttempts: 3,
  // Seconds a cached counter base stays valid before it is re-read from the database.
  baseTtl: 300
}

const LOCK_KEY = 'wb:lock:flush'
const LOCK_TTL = 10
// Envelope marker for re-queued rows; carries the number of failed attempts.
const ATTEMPTS = '__odac_wb_attempts'
// Checkpoint prefixes in Storage: counters, updates, queues, dead letters.
const CHECKPOINT_PREFIXES = ['wb:c:', 'wb:u:', 'wb:q:', 'wb:d:']

class WriteBuffer {
  constructor() {
    this._flushTimer = null
    this._checkpointTimer = null
    this._config = {}
    this._initialized = false
    // Queues this process saw at or above maxQueueLength.
    this._overflowing = new Set()
  }

  // ─── Lifecycle ──────────────────────────────────────────────

  /**
   * Why: Initializes the WriteBuffer. Called from Database.init() after Ipc is ready.
   * Primary: recovers LMDB checkpoint, starts flush/checkpoint timers.
   * All processes: stores connection references for flush DB writes.
   * @param {object} connections - Knex connection map {connectionKey: knexInstance}
   * @param {object} nanoidColumns - NanoID column metadata from DatabaseManager {connectionKey: {tableName: [{column, size}]}}
   */
  async init(connections, nanoidColumns = {}) {
    if (this._initialized) return
    this._initialized = true

    this._connections = connections
    this._nanoidColumns = nanoidColumns
    this._config = {...DEFAULT_CONFIG, ...Odac.Config.buffer}
    if (!this._config.checkpointInterval) this._config.checkpointInterval = Math.max(500, Math.floor(this._config.flushInterval / 2))
    if (this._config.maxQueueLength === null || this._config.maxQueueLength === undefined) {
      this._config.maxQueueLength = this._config.maxQueueSize * 10
    }

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
   * Once the queue reaches maxQueueLength (the flush is failing or cannot keep up), rows
   * are inserted directly instead: the queue stops growing, no row is dropped, and an
   * outage surfaces to the caller as a rejected insert rather than silent memory growth.
   * @throws When the queue is full and the direct insert fails.
   */
  async insert(connection, table, row) {
    // Auto-generate nanoid values for columns defined as type 'nanoid' in schema.
    // Why: The Database.js proxy nanoid injection only covers direct QB calls.
    // WriteBuffer bypasses that proxy — rows must be populated here before queuing.
    const nanoidCols = this._nanoidColumns?.[connection]?.[table]
    if (nanoidCols) {
      for (const {column, size} of nanoidCols) {
        if (!row[column]) row[column] = nanoid(size)
      }
    }

    const queueKey = `${connection}:${table}`
    if (this._overflowing.has(queueKey)) {
      if ((await Odac.Ipc.llen(`wb:q:${queueKey}`)) >= this._config.maxQueueLength) return this._insertDirect(connection, table, row)
      this._overflowing.delete(queueKey)
    }

    const length = await Odac.Ipc.rpush(`wb:q:${queueKey}`, row)
    await Odac.Ipc.sadd('wb:idx:queues', queueKey)
    if (this._config.maxQueueLength > 0 && length >= this._config.maxQueueLength) {
      if (!this._overflowing.has(queueKey)) {
        console.error(
          `\x1b[31m[WriteBuffer]\x1b[0m Insert queue for ${table} reached maxQueueLength (${length} rows); inserting directly until it drains.`
        )
      }
      this._overflowing.add(queueKey)
    }

    // Auto-flush when queue exceeds threshold. One at a time per process: while the database
    // rejects the batch, every further insert would otherwise start another full attempt.
    if (length >= this._config.maxQueueSize && !this._autoFlushing) {
      this._autoFlushing = true
      void this._flushQueues(connection, table)
        .catch(() => {})
        .finally(() => (this._autoFlushing = false))
    }

    return true
  }

  /**
   * Inserts one row past the queue cap, so neither a dead database nor a lagging flush
   * grows the queue further. Buffering resumes once the queue length drops below the cap.
   */
  async _insertDirect(connection, table, row) {
    const knex = this._connections?.[connection]
    if (!knex) throw new Error(`[WriteBuffer] Unknown connection "${connection}"`)
    try {
      if (this._dialect(knex) === 'clickhouse') await knex.insert(table, [row])
      else await knex(table).insert(row)
    } catch (error) {
      throw new Error(`[WriteBuffer] Insert queue for ${table} is full and the direct insert failed: ${error?.message ?? error}`, {
        cause: error
      })
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
    const owner = nanoid(21)
    const acquired = await Odac.Ipc.lock(LOCK_KEY, LOCK_TTL, owner)
    if (!acquired) return

    // Keep the lock while flushing. If it is lost anyway (e.g. a stalled process), stop before
    // the next group so two flushers never apply the same counter delta twice.
    const guard = {lost: false}
    const renew = setInterval(
      () => {
        Odac.Ipc.extendLock(LOCK_KEY, owner, LOCK_TTL)
          .then(held => {
            if (!held) guard.lost = true
          })
          .catch(() => {})
      },
      (LOCK_TTL * 1000) / 3
    )
    renew.unref?.()

    try {
      await this._flushCounters(connection, table, guard)
      await this._flushUpdates(connection, table, guard)
      await this._flushQueues(connection, table, guard)
      if (guard.lost) console.error('\x1b[31m[WriteBuffer]\x1b[0m Flush lock was lost; remaining groups are left for the next cycle.')
    } finally {
      clearInterval(renew)
      await Odac.Ipc.unlock(LOCK_KEY, owner)
    }
  }

  /**
   * Returns rows that could not be inserted after `maxInsertAttempts` flush cycles.
   * Why: a row the database keeps rejecting (constraint violation, bad type) must not block the
   * rows queued after it; it is set aside here for inspection or manual replay.
   * @returns {Promise<Array<{row: object, error: string, at: number}>>}
   */
  async deadLetters(connection, table) {
    return Odac.Ipc.lrange(`wb:dlq:${connection}:${table}`, 0, -1)
  }

  // ─── Flush Logic ───────────────────────────────────────────

  async _flushCounters(filterConnection, filterTable, guard = {lost: false}) {
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
      if (guard.lost) return
      const knex = this._connections[group.connection]
      if (!knex) continue

      // ClickHouse has no cheap row-level UPDATE; counter buffering is an OLTP-only feature.
      // Such keys should never be created for a CH connection, but skip defensively if seen.
      if (this._dialect(knex) === 'clickhouse') continue

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

        // After successful commit: subtract flushed deltas. The cached base is dropped rather
        // than adjusted, so the next read takes the committed value from the database; this
        // also picks up changes made to the row outside the buffer.
        for (const [entryKey, entry] of deltas) {
          await Odac.Ipc.decrBy(`wb:c:${entryKey}`, entry.delta)
          await Odac.Ipc.del(`wb:b:${entryKey}`)

          // If counter is now 0, clean up
          const remaining = (await Odac.Ipc.get(`wb:c:${entryKey}`)) || 0
          if (remaining === 0) {
            await Odac.Ipc.del(`wb:c:${entryKey}`)
            await Odac.Ipc.srem('wb:idx:counters', entryKey)
          }
        }
        // The checkpointed delta is now in the database; replaying it would count it twice.
        this._dropCheckpoint([...deltas.keys()].map(key => `wb:c:${key}`))
      } catch (err) {
        // Keep deltas in Ipc on failure — will retry next cycle
        console.error(`\x1b[31m[WriteBuffer]\x1b[0m Counter flush failed for ${group.table}:`, err.message)
      }
    }
  }

  async _flushUpdates(filterConnection, filterTable, guard = {lost: false}) {
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
      if (guard.lost) return
      const knex = this._connections[group.connection]
      if (!knex) continue

      // ClickHouse has no cheap row-level UPDATE — update buffering is OLTP-only (see _flushCounters).
      if (this._dialect(knex) === 'clickhouse') continue

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
        this._dropCheckpoint([...updates.keys()].map(key => `wb:u:${key}`))
      } catch (err) {
        console.error(`\x1b[31m[WriteBuffer]\x1b[0m Update flush failed for ${group.table}:`, err.message)
      }
    }
  }

  async _flushQueues(filterConnection, filterTable, guard = {lost: false}) {
    const queueKeys = await Odac.Ipc.smembers('wb:idx:queues')
    if (queueKeys.length === 0) return

    for (const queueKey of queueKeys) {
      if (guard.lost) return
      const [connection, table] = queueKey.split(':')
      if (filterConnection && connection !== filterConnection) continue
      if (filterTable && table !== filterTable) continue

      const knex = this._connections[connection]
      if (!knex) continue

      // Atomic drain — reads all rows and clears the list in one step
      const items = (await Odac.Ipc.lrangeAndDel(`wb:q:${queueKey}`)).map(item => this._unwrapQueued(item))
      if (items.length === 0) continue

      let failed
      try {
        failed = await this._insertItems(knex, table, items)
      } catch (err) {
        // Not even row-by-row inserts could run: keep everything for the next cycle.
        failed = items.map(item => ({item, error: err}))
      }

      if (failed.length === 0) {
        await Odac.Ipc.srem('wb:idx:queues', queueKey)
        this._dropCheckpoint([`wb:q:${queueKey}`])
        continue
      }

      // Every row failing while the database answers points at the rows; otherwise it is an
      // outage, which must not use up the rows' attempts.
      const rowsAtFault = failed.length < items.length || (await this._reachable(knex))
      const dead = []
      for (const {item, error} of failed) {
        const attempts = rowsAtFault ? item.attempts + 1 : item.attempts
        if (attempts >= this._config.maxInsertAttempts) dead.push({row: item.row, error: String(error?.message ?? error), at: Date.now()})
        else await Odac.Ipc.rpush(`wb:q:${queueKey}`, {[ATTEMPTS]: attempts, row: item.row})
      }

      if (dead.length > 0) {
        for (const letter of dead) await Odac.Ipc.rpush(`wb:dlq:${queueKey}`, letter)
        await Odac.Ipc.sadd('wb:idx:dlq', queueKey)
        console.error(
          `\x1b[31m[WriteBuffer]\x1b[0m ${dead.length} row(s) for ${table} failed ${this._config.maxInsertAttempts} times and were moved to the dead-letter list (wb:dlq:${queueKey}). Last error: ${dead[dead.length - 1].error}`
        )
      }

      const requeued = failed.length - dead.length
      if (requeued > 0) {
        console.error(`\x1b[31m[WriteBuffer]\x1b[0m Queue flush failed for ${table} (${requeued} row(s) kept):`, failed[0].error?.message)
      } else {
        await Odac.Ipc.srem('wb:idx:queues', queueKey)
      }
      // Some rows may have been inserted: the old checkpoint would replay them.
      if (failed.length < items.length || dead.length > 0) await this._rewriteQueueCheckpoint(queueKey)
    }
  }

  /**
   * Inserts queued rows, isolating the ones the database rejects.
   * @returns {Promise<Array<{item, error}>>} Rows that could not be inserted.
   */
  async _insertItems(knex, table, items) {
    const size = this._config.insertBatchSize
    const isClickHouse = this._dialect(knex) === 'clickhouse'
    const insertOne = item => (isClickHouse ? knex.insert(table, [item.row]) : knex(table).insert(item.row))
    const isolate = async (chunk, error) => {
      // During an outage every single-row attempt would wait for its own connection timeout.
      if (!(await this._reachable(knex))) return chunk.map(item => ({item, error}))
      const failed = []
      for (const item of chunk) {
        try {
          await insertOne(item)
        } catch (error) {
          failed.push({item, error})
        }
      }
      return failed
    }

    if (isClickHouse) {
      // No multi-statement transactions; each chunk insert is atomic on its own, so only a
      // failing chunk is retried row by row.
      const failed = []
      for (let i = 0; i < items.length; i += size) {
        const chunk = items.slice(i, i + size)
        try {
          await knex.insert(
            table,
            chunk.map(item => item.row)
          )
        } catch (error) {
          failed.push(...(await isolate(chunk, error)))
        }
      }
      return failed
    }

    try {
      // One transaction for all chunks so a failure leaves nothing half-inserted.
      await knex.transaction(async trx => {
        for (let i = 0; i < items.length; i += size) {
          await trx(table).insert(items.slice(i, i + size).map(item => item.row))
        }
      })
      return []
    } catch (error) {
      return isolate(items, error)
    }
  }

  _unwrapQueued(item) {
    if (item && typeof item === 'object' && ATTEMPTS in item && 'row' in item) return {row: item.row, attempts: item[ATTEMPTS]}
    return {row: item, attempts: 0}
  }

  async _reachable(knex) {
    try {
      await knex.raw(this._dialect(knex) === 'clickhouse' ? 'SELECT 1' : 'select 1')
      return true
    } catch {
      return false
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
      await Odac.Ipc.set(baseKey, value, this._config.baseTtl)
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

    // Read everything first, then write one consistent snapshot in a single transaction.
    const snapshot = new Map()

    for (const key of await Odac.Ipc.smembers('wb:idx:counters')) {
      const delta = (await Odac.Ipc.get(`wb:c:${key}`)) || 0
      if (delta === 0) continue
      const base = (await Odac.Ipc.get(`wb:b:${key}`)) || 0
      snapshot.set(`wb:c:${key}`, {delta, base})
    }

    for (const key of await Odac.Ipc.smembers('wb:idx:updates')) {
      const data = await Odac.Ipc.hgetall(`wb:u:${key}`)
      if (data && Object.keys(data).length > 0) snapshot.set(`wb:u:${key}`, data)
    }

    for (const key of await Odac.Ipc.smembers('wb:idx:queues')) {
      const rows = await Odac.Ipc.lrange(`wb:q:${key}`, 0, -1)
      if (rows.length > 0) snapshot.set(`wb:q:${key}`, rows)
    }

    for (const key of await Odac.Ipc.smembers('wb:idx:dlq')) {
      const rows = await Odac.Ipc.lrange(`wb:dlq:${key}`, 0, -1)
      if (rows.length > 0) snapshot.set(`wb:d:${key}`, rows)
    }

    this._storageTransaction(() => {
      // Entries no longer pending (flushed elsewhere) must not be replayed on recovery.
      for (const prefix of CHECKPOINT_PREFIXES) {
        for (const {key} of Odac.Storage.getRange({start: prefix, end: prefix + '~'})) {
          if (!snapshot.has(key)) Odac.Storage.removeSync(key)
        }
      }
      for (const [key, value] of snapshot) Odac.Storage.putSync(key, value)
    })
  }

  _storageTransaction(callback) {
    if (typeof Odac.Storage.transactionSync === 'function') return Odac.Storage.transactionSync(callback)
    return callback()
  }

  /**
   * Removes checkpoint entries whose data has reached the database.
   * Why: only entries that were actually written may go; a failed group's checkpoint is the
   * copy that survives a crash while the database is unavailable.
   */
  _dropCheckpoint(keys) {
    if (keys.length === 0) return
    if (Odac.Ipc?.config?.driver === 'redis') return
    if (!Odac.Storage?.isReady()) return
    this._storageTransaction(() => {
      for (const key of keys) Odac.Storage.removeSync(key)
    })
  }

  async _rewriteQueueCheckpoint(queueKey) {
    if (Odac.Ipc?.config?.driver === 'redis') return
    if (!Odac.Storage?.isReady()) return
    const rows = await Odac.Ipc.lrange(`wb:q:${queueKey}`, 0, -1)
    const dead = await Odac.Ipc.lrange(`wb:dlq:${queueKey}`, 0, -1)
    this._storageTransaction(() => {
      if (rows.length > 0) Odac.Storage.putSync(`wb:q:${queueKey}`, rows)
      else Odac.Storage.removeSync(`wb:q:${queueKey}`)
      if (dead.length > 0) Odac.Storage.putSync(`wb:d:${queueKey}`, dead)
    })
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

    // Recover dead letters
    for (const {key, value} of Odac.Storage.getRange({start: 'wb:d:', end: 'wb:d:~'})) {
      if (!Array.isArray(value)) continue
      const queueKey = key.slice(5)
      for (const letter of value) await Odac.Ipc.rpush(`wb:dlq:${queueKey}`, letter)
      await Odac.Ipc.sadd('wb:idx:dlq', queueKey)
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

  /**
   * Resolves a connection's dialect so flush logic can branch OLTP (Knex) vs. OLAP (ClickHouse).
   * @param {object} conn - Knex instance or ClickHouseAdapter
   * @returns {string} Dialect identifier
   */
  _dialect(conn) {
    return conn._odacDialect || conn.client?.config?.client || 'unknown'
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

    // With IPC already torn down the buffer is unreachable: a flush would see
    // nothing, report success and clear the checkpoint, the only remaining copy.
    if (cluster.isPrimary && !Odac.Ipc?.initialized) {
      console.error('\x1b[31m[WriteBuffer]\x1b[0m Final flush skipped: IPC closed first. Checkpoint kept for recovery.')
    } else if (cluster.isPrimary) {
      try {
        // Force-acquire lock for final flush (bypass distributed lock)
        await Odac.Ipc.unlock(LOCK_KEY)
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

    this._overflowing.clear()
    this._initialized = false
  }
}

module.exports = new WriteBuffer()
