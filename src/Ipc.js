const cluster = require('node:cluster')
const {EventEmitter} = require('node:events')

function copy(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

// worker.send() to a worker whose channel is closing emits 'error' on the worker when no
// callback is given; nothing listens for it, so it would crash the primary.
function sendToWorker(worker, message) {
  if (!worker || !worker.isConnected?.()) return
  worker.send(message, error => {
    if (error)
      console.error(JSON.stringify({level: 'WARN', message: 'Ipc could not reach a worker', worker: worker.id, error: error.message}))
  })
}

class Ipc extends EventEmitter {
  constructor() {
    super()
    this.driver = null
    this.config = {}
    this._requests = new Map() // For memory driver response tracking
    this._subs = new Map() // For memory driver subscriptions
    this._redisBridges = new Map() // channel -> the single node-redis listener bridging to our EventEmitter
    this._lockOwners = new Map() // key -> owner token of a lock this process acquired without naming one
  }

  /**
   * ARCHITECTURE NOTE:
   * This module implements a "Primary-Replica" pattern for the 'memory' driver.
   * - The Primary process holds the 'Source of Truth' in local Maps.
   * - Workers communicate via IPC (process.send) to read/write to this central store.
   * This ensures state consistency across the cluster without needing Redis.
   */
  async init() {
    if (this.initialized) return
    this.initialized = true

    this.config = Odac.Config.ipc || {driver: 'memory'}

    // default MaxListeners is 10. If we have thousands of different channels, it's fine.
    // But if we attach many listeners to the "same" channel or event emitter, we might need more.
    // For Ipc (which extends EventEmitter), let's bump it up just in case.
    this.setMaxListeners(0) // Unlimited

    if (this.config.driver === 'redis') {
      await this._initRedis()
    } else {
      await this._initMemory()
    }
  }

  // --- Public API ---

  async set(key, value, ttl = 0) {
    if (this.config.driver === 'redis') {
      // node-redis v4+ takes SET options as an object; positional 'EX', ttl is ignored there.
      return ttl > 0 ? this.redis.set(key, JSON.stringify(value), {EX: ttl}) : this.redis.set(key, JSON.stringify(value))
    } else {
      return this._sendMemory('set', {key, value, ttl})
    }
  }

  async get(key) {
    if (this.config.driver === 'redis') {
      const val = await this.redis.get(key)
      return val ? JSON.parse(val) : null
    } else {
      return this._sendMemory('get', {key})
    }
  }

  async del(key) {
    if (this.config.driver === 'redis') {
      return this.redis.del(key)
    } else {
      return this._sendMemory('del', {key})
    }
  }

  // --- Atomic Counter Operations ---

  /**
   * Why: Atomically increment a numeric value. Essential for Write-Behind Cache counters
   * where concurrent workers must not cause lost updates (get→modify→set race).
   * Redis: INCRBYFLOAT. Memory: single-threaded Primary guarantees atomicity.
   *
   * A `ttl` makes the counter a fixed window: the expiry is set when the key is created and
   * not extended by later increments, so short-lived counters (rate limits) clean themselves up
   * instead of accumulating one key per client forever.
   *
   * @param {string} key
   * @param {number} delta - Amount to add (can be negative)
   * @param {number} [ttl=0] - Seconds until a newly created counter expires; 0 keeps it forever
   * @returns {Promise<number>} New value after increment
   */
  async incrBy(key, delta, ttl = 0) {
    if (this.config.driver === 'redis') {
      const value = Number(await this.redis.incrByFloat(key, delta))
      // The first increment is the one that created the key.
      if (ttl > 0 && value === delta) await this.redis.expire(key, ttl)
      return value
    }
    return this._sendMemory('incrBy', {key, delta, ttl})
  }

  /**
   * Why: Convenience wrapper. Flush logic needs to subtract flushed deltas atomically.
   */
  async decrBy(key, delta) {
    return this.incrBy(key, -delta)
  }

  // --- Hash Operations ---

  /**
   * Why: Write-Behind Cache update coalescing stores pending column updates as hash fields.
   * Merge semantics: existing fields are overwritten, new fields are added (last-write-wins).
   * Redis: HSET key f1 v1 f2 v2. Memory: Object.assign into stored object.
   *
   * @param {string} key
   * @param {object} obj - Field-value pairs to merge
   * @returns {Promise<boolean>}
   */
  async hset(key, obj) {
    if (this.config.driver === 'redis') {
      const args = {}
      for (const [field, value] of Object.entries(obj)) {
        args[field] = JSON.stringify(value)
      }
      await this.redis.hSet(key, args)
      return true
    }
    return this._sendMemory('hset', {key, obj})
  }

  /**
   * Why: Flush reads all pending update fields for a row in one call.
   *
   * @param {string} key
   * @returns {Promise<object|null>} All field-value pairs, or null if key doesn't exist
   */
  async hgetall(key) {
    if (this.config.driver === 'redis') {
      const raw = await this.redis.hGetAll(key)
      if (!raw || Object.keys(raw).length === 0) return null
      const result = {}
      for (const [field, value] of Object.entries(raw)) {
        result[field] = JSON.parse(value)
      }
      return result
    }
    return this._sendMemory('hgetall', {key})
  }

  // --- List Operations ---

  /**
   * Why: Write-Behind Cache batch insert queue. Workers push rows to a shared list;
   * flush drains it to the database in a single INSERT.
   * Redis: RPUSH. Memory: Array.push on Primary.
   *
   * @param {string} key
   * @param {...*} items - Items to append
   * @returns {Promise<number>} New list length
   */
  async rpush(key, ...items) {
    if (this.config.driver === 'redis') {
      const serialized = items.map(i => JSON.stringify(i))
      return this.redis.rPush(key, serialized)
    }
    return this._sendMemory('rpush', {key, items})
  }

  /**
   * Why: Flush reads queued rows before writing them to the database.
   *
   * @param {string} key
   * @param {number} start - Start index (0-based, inclusive)
   * @param {number} stop - End index (inclusive, -1 for last element)
   * @returns {Promise<Array>} Elements in range
   */
  async lrange(key, start, stop) {
    if (this.config.driver === 'redis') {
      const raw = await this.redis.lRange(key, start, stop)
      return raw.map(i => JSON.parse(i))
    }
    return this._sendMemory('lrange', {key, start, stop})
  }

  /**
   * Why: WriteBuffer checks whether a full insert queue has drained without copying it.
   * @param {string} key
   * @returns {Promise<number>} List length (0 when missing)
   */
  async llen(key) {
    if (this.config.driver === 'redis') return this.redis.lLen(key)
    return this._sendMemory('llen', {key})
  }

  /**
   * Why: Atomic read-and-clear for queue flush. Prevents data loss caused by
   * non-atomic lrange() + del() where new rpush() arrivals between the two
   * calls would be silently deleted. Redis: MULTI/EXEC pipeline.
   * Memory: single-threaded Primary guarantees atomicity.
   *
   * @param {string} key
   * @returns {Promise<Array>} All elements that were in the list
   */
  async lrangeAndDel(key) {
    if (this.config.driver === 'redis') {
      const results = await this.redis.multi().lRange(key, 0, -1).del(key).exec()
      const raw = results[0]
      if (!raw || !Array.isArray(raw)) return []
      return raw.map(i => JSON.parse(i))
    }
    return this._sendMemory('lrangeAndDel', {key})
  }

  // --- Set Operations ---

  /**
   * Why: WriteBuffer maintains index sets (e.g., 'wb:idx:counters') to track which keys
   * have pending data. Avoids expensive SCAN/KEYS pattern matching on flush.
   *
   * @param {string} key
   * @param {...string} members
   * @returns {Promise<number>} Number of members added
   */
  async sadd(key, ...members) {
    if (this.config.driver === 'redis') {
      return this.redis.sAdd(key, members)
    }
    return this._sendMemory('sadd', {key, members})
  }

  /**
   * Why: Flush iterates all tracked keys in an index set to drain pending data.
   *
   * @param {string} key
   * @returns {Promise<Array<string>>} All members
   */
  async smembers(key) {
    if (this.config.driver === 'redis') {
      return this.redis.sMembers(key)
    }
    return this._sendMemory('smembers', {key})
  }

  /**
   * Why: After flushing a counter/update/queue key, remove it from the tracking index.
   *
   * @param {string} key
   * @param {...string} members
   * @returns {Promise<number>} Number of members removed
   */
  async srem(key, ...members) {
    if (this.config.driver === 'redis') {
      return this.redis.sRem(key, members)
    }
    return this._sendMemory('srem', {key, members})
  }

  // --- Distributed Lock ---

  /**
   * Why: Horizontal scaling requires exactly ONE server to run flush at a time.
   * Redis: SET NX EX (atomic test-and-set with TTL). Memory: Primary-local entry.
   * TTL prevents deadlocks if the lock holder crashes mid-flush. The stored owner token lets
   * the holder release or extend only its own lock: without it, a holder that outlived the TTL
   * would delete the lock a second process had acquired meanwhile.
   *
   * Without an owner, a random token is generated and remembered by this process, so the
   * documented lock(key) ... unlock(key) pattern is ownership-checked too.
   *
   * @param {string} key
   * @param {number} [ttl=10] - Lock time-to-live in seconds
   * @param {string} [owner] - Token identifying the holder
   * @returns {Promise<boolean>} true if lock acquired
   */
  async lock(key, ttl = 10, owner) {
    const token = owner === undefined ? require('node:crypto').randomUUID() : String(owner)
    let acquired
    if (this.config.driver === 'redis') {
      acquired = (await this.redis.set(key, token, {NX: true, EX: ttl})) === 'OK'
    } else {
      acquired = await this._sendMemory('lock', {key, ttl, owner: token})
    }
    if (acquired && owner === undefined) this._lockOwners.set(key, token)
    return acquired
  }

  /**
   * Why: Release a lock after the critical section so the next holder can proceed.
   * The lock is released only if it is still held by `owner` (or, without one, by this
   * process's lock(key) call). A holder that outlived its TTL therefore cannot delete the lock
   * another process acquired meanwhile. Use forceUnlock() to break a stale lock.
   * @returns {Promise<boolean>} true if a lock was released
   */
  async unlock(key, owner) {
    if (owner === undefined) {
      owner = this._lockOwners.get(key)
      if (owner === undefined) return false
      this._lockOwners.delete(key)
    }
    if (this.config.driver === 'redis') {
      const script = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end"
      return Number(await this.redis.eval(script, {keys: [key], arguments: [String(owner)]})) === 1
    }
    return this._sendMemory('unlock', {key, owner: String(owner)})
  }

  /**
   * Removes a lock whoever holds it.
   * Why: breaking a stale lock is a deliberate act (e.g. the final flush at shutdown), never
   * the side effect of an unlock() without an owner.
   * @returns {Promise<boolean>} true if a lock was removed
   */
  async forceUnlock(key) {
    this._lockOwners.delete(key)
    const removed = await this.del(key) // memory: boolean, redis: count
    return removed === true || Number(removed) > 0
  }

  /**
   * Why: Lets a long-running holder keep its lock alive instead of losing it at the TTL.
   * @returns {Promise<boolean>} false if the lock is no longer held by `owner`
   */
  async extendLock(key, owner, ttl = 10) {
    if (owner === undefined) owner = this._lockOwners.get(key)
    if (owner === undefined) return false
    if (this.config.driver === 'redis') {
      const script = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('expire', KEYS[1], ARGV[2]) else return 0 end"
      return Number(await this.redis.eval(script, {keys: [key], arguments: [String(owner), String(ttl)]})) === 1
    }
    return this._sendMemory('extendLock', {key, ttl, owner: String(owner)})
  }

  async publish(channel, message) {
    if (this.config.driver === 'redis') {
      return this.redis.publish(channel, JSON.stringify(message))
    } else {
      return this._sendMemory('publish', {channel, message})
    }
  }

  /**
   * A single channel may carry several independent consumers (e.g. a long-lived stats
   * listener and a short-lived ack listener on the same stream). The callback reference
   * is what tells them apart, so both drivers key subscriptions on it and both must be
   * able to remove one without disturbing the others.
   *
   * @param {string} channel
   * @param {function} callback
   * @returns {Promise<{channel: string, callback: function, unsubscribe: function}>} Handle
   *   that removes only this subscription, so callers need not retain the callback themselves.
   */
  async subscribe(channel, callback) {
    if (typeof callback !== 'function') {
      throw new TypeError(`Odac.Ipc.subscribe('${channel}') requires a callback function.`)
    }

    if (this.config.driver === 'redis') {
      if (!this.subRedis) {
        this.subRedis = this.redis.duplicate()
        await this.subRedis.connect()
      }
      // node-redis v4+ delivers messages to a per-channel listener passed to subscribe();
      // it does not emit a client-wide 'message' event. We register exactly one bridge
      // listener per channel and fan out locally, so removing one consumer never tears
      // down the Redis subscription the other consumers still depend on.
      if (!this._redisBridges.has(channel)) {
        const bridge = raw => {
          let message
          try {
            message = JSON.parse(raw)
          } catch (err) {
            console.error('[Odac Ipc] Failed to parse message on channel "' + channel + '":', err)
            return
          }
          for (const listener of this.listeners(channel)) this._deliver(channel, listener, message)
        }
        this._redisBridges.set(channel, bridge)
        try {
          await this.subRedis.subscribe(channel, bridge)
        } catch (err) {
          this._redisBridges.delete(channel)
          throw err
        }
      }
      this.on(channel, callback)
    } else {
      // Memory driver subscription
      if (!this._subs.has(channel)) {
        this._subs.set(channel, new Set())
        // Inform main process that this worker is subscribed
        this._sendMemory('subscribe', {channel})
      }
      this._subs.get(channel).add(callback)
    }

    return {channel, callback, unsubscribe: () => this.unsubscribe(channel, callback)}
  }

  /**
   * Removes a single subscription. Other consumers of the same channel keep receiving
   * messages; the underlying Redis/Primary subscription is torn down only once the last
   * consumer is gone.
   */
  async unsubscribe(channel, callback) {
    if (typeof callback !== 'function') {
      // Without a callback there is no way to know which consumer is leaving, so we
      // refuse to guess: silently dropping the call leaks the listener, and dropping
      // every listener would kill co-tenants on the channel.
      console.warn(
        `[Odac Ipc] unsubscribe('${channel}') was called without a callback and did nothing. ` +
          `Pass the callback (or the handle returned by subscribe()) to remove one subscription, ` +
          `or call unsubscribeAll('${channel}') to remove every subscription on the channel. ` +
          `This call will throw in the next major version.`
      )
      return
    }

    if (this.config.driver === 'redis') {
      this.removeListener(channel, callback)
      // If no more listeners for this channel, unsubscribe from redis to save resources
      if (this.listenerCount(channel) === 0) {
        await this._teardownRedisChannel(channel)
      }
    } else {
      const callbacks = this._subs.get(channel)
      if (!callbacks || !callbacks.delete(callback)) return
      if (callbacks.size === 0) {
        this._subs.delete(channel)
        this._sendMemory('unsubscribe', {channel})
      }
    }
  }

  /**
   * Removes every subscription on a channel. Kept separate from unsubscribe() so that
   * tearing down a shared channel is always a deliberate act, never an accident.
   */
  async unsubscribeAll(channel) {
    if (this.config.driver === 'redis') {
      this.removeAllListeners(channel)
      await this._teardownRedisChannel(channel)
    } else {
      if (this._subs.delete(channel)) {
        this._sendMemory('unsubscribe', {channel})
      }
    }
  }

  async _teardownRedisChannel(channel) {
    const bridge = this._redisBridges.get(channel)
    if (!bridge) return
    this._redisBridges.delete(channel)
    if (this.subRedis) await this.subRedis.unsubscribe(channel, bridge)
  }

  // --- Drivers ---

  async _initRedis() {
    try {
      const Redis = require('redis')
      this.redis = Redis.createClient(Odac.Config.database?.redis?.[this.config.redis || 'default'] || {})
      await this.redis.connect()
    } catch (e) {
      if (e.code === 'MODULE_NOT_FOUND') {
        throw new Error('IPC Redis driver requires the "redis" package. Run: npm install redis')
      }
      throw e
    }
  }

  async _initMemory() {
    if (cluster.isPrimary) {
      if (!this._memoryStore) this._memoryStore = new Map()
      if (!this._memorySubs) this._memorySubs = new Map()

      // PREVENT DUPLICATE LISTENERS via Global References
      // If Ipc is reloaded (hot-reload), the old listener remains on 'cluster' (global).
      // We must remove it before adding a new one.

      if (global.__odac_ipc_message_handler) {
        cluster.removeListener('message', global.__odac_ipc_message_handler)
      }
      if (global.__odac_ipc_exit_handler) {
        cluster.removeListener('exit', global.__odac_ipc_exit_handler)
      }

      const messageHandler = (worker, msg) => {
        if (msg && msg.type && msg.type.startsWith('ipc:')) {
          this._handlePrimaryMessage(worker, msg)
        }
      }

      const exitHandler = worker => {
        // Cleanup worker subscriptions on exit
        for (const [channel, workers] of this._memorySubs) {
          workers.delete(worker.id)
          if (workers.size === 0) {
            this._memorySubs.delete(channel)
          }
        }
      }

      // Save references globally
      global.__odac_ipc_message_handler = messageHandler
      global.__odac_ipc_exit_handler = exitHandler

      cluster.on('message', messageHandler)
      cluster.on('exit', exitHandler)

      this._startGarbageCollector()
    } else {
      process.on('message', msg => {
        if (msg && msg.type === 'ipc:response') {
          const req = this._requests.get(msg.id)
          // If request exists (hasn't timed out yet)
          if (req) {
            clearTimeout(req.timeout) // Stop the timeout timer
            req.resolve(msg.data)
            this._requests.delete(msg.id)
          }
        } else if (msg && msg.type === 'ipc:message') {
          // Pub/Sub message received from Primary
          const subs = this._subs.get(msg.channel)
          if (subs) {
            for (const cb of subs) this._deliver(msg.channel, cb, msg.message)
          }
        }
      })
    }
  }

  /**
   * Invokes one subscriber callback in isolation.
   *
   * Why: callbacks are user code running inside the worker's process 'message'
   * listener (memory) or the Redis bridge. A throw would escape as an uncaught
   * exception and a rejection as an unhandled rejection; either terminates the
   * worker and every connection on it. Containing it also keeps one faulty
   * consumer from starving its co-tenants on the channel.
   */
  _deliver(channel, callback, message) {
    const report = err =>
      console.error(JSON.stringify({level: 'ERROR', message: `Ipc subscriber on "${channel}" failed`, error: err?.message ?? String(err)}))
    try {
      const result = callback(message)
      if (result && typeof result.then === 'function') result.then(undefined, report)
    } catch (err) {
      report(err)
    }
  }

  _sendMemory(action, payload) {
    if (cluster.isPrimary) {
      // If used from primary directly (rare but possible)
      // Logic would be direct call to _handlePrimaryMessage logic essentially,
      // but simpler. For now, assuming IPC is mostly used by workers.
      // If primary uses it, we should implement direct store access.
      return this._handleDirectPrimaryCall(action, payload)
    }

    return new Promise((resolve, reject) => {
      const id = require('node:crypto').randomUUID()
      if (action !== 'subscribe' && action !== 'publish' && action !== 'unsubscribe') {
        // Only wait for response for data ops
        const timeout = setTimeout(() => {
          if (this._requests.has(id)) {
            this._requests.delete(id)
            reject(new Error(`IPC request timed out: ${action}`))
          }
        }, 5000)

        this._requests.set(id, {resolve, reject, timeout})
      } else {
        resolve() // Pub/Sub/Unsub doesn't wait for ack
      }
      process.send({type: `ipc:${action}`, id, ...payload})
    })
  }

  // Calls made on the primary itself (cron jobs) must see the same semantics as workers, whose
  // values cross process.send() as JSON: get() used to return the stored object itself, so a
  // caller mutating it changed the cache for everyone.
  _handleDirectPrimaryCall(action, payload) {
    return copy(this._executePrimaryAction(action, copy(payload)))
  }

  /**
   * Why: Single source of truth for all memory-driver operations.
   * Both _handlePrimaryMessage (worker→primary) and _handleDirectPrimaryCall (primary self-call)
   * funnel through this method, eliminating logic duplication.
   */
  _executePrimaryAction(action, msg) {
    switch (action) {
      case 'set': {
        const expireAt = msg.ttl > 0 ? Date.now() + msg.ttl * 1000 : Infinity
        this._memoryStore.set(msg.key, {value: msg.value, expireAt})
        return true
      }
      case 'get': {
        const data = this._memoryStore.get(msg.key)
        if (!data) return null
        if (data.expireAt !== Infinity && Date.now() > data.expireAt) {
          this._memoryStore.delete(msg.key)
          return null
        }
        return data.value
      }
      case 'del':
        return this._memoryStore.delete(msg.key)

      // --- Atomic Counter ---
      case 'incrBy': {
        let data = this._memoryStore.get(msg.key)
        if (!data || (data.expireAt !== Infinity && Date.now() > data.expireAt)) {
          data = {value: 0, expireAt: msg.ttl > 0 ? Date.now() + msg.ttl * 1000 : Infinity}
        }
        data.value = (typeof data.value === 'number' ? data.value : 0) + msg.delta
        this._memoryStore.set(msg.key, data)
        return data.value
      }

      // --- Hash ---
      case 'hset': {
        const data = this._memoryStore.get(msg.key) || {value: {}, expireAt: Infinity}
        if (typeof data.value !== 'object' || data.value === null || Array.isArray(data.value)) {
          data.value = {}
        }
        Object.assign(data.value, msg.obj)
        this._memoryStore.set(msg.key, data)
        return true
      }
      case 'hgetall': {
        const data = this._memoryStore.get(msg.key)
        if (!data || typeof data.value !== 'object' || Array.isArray(data.value)) return null
        return {...data.value}
      }

      // --- List ---
      case 'rpush': {
        const data = this._memoryStore.get(msg.key) || {value: [], expireAt: Infinity}
        if (!Array.isArray(data.value)) data.value = []
        data.value.push(...msg.items)
        this._memoryStore.set(msg.key, data)
        return data.value.length
      }
      case 'lrange': {
        const data = this._memoryStore.get(msg.key)
        if (!data || !Array.isArray(data.value)) return []
        return msg.stop === -1 ? data.value.slice(msg.start) : data.value.slice(msg.start, msg.stop + 1)
      }
      case 'llen': {
        const data = this._memoryStore.get(msg.key)
        return data && Array.isArray(data.value) ? data.value.length : 0
      }
      case 'lrangeAndDel': {
        const data = this._memoryStore.get(msg.key)
        if (!data || !Array.isArray(data.value)) return []
        const items = data.value
        this._memoryStore.delete(msg.key)
        return items
      }

      // --- Set ---
      // Members live in a Set: membership checks were Array.includes/indexOf, O(n) per member.
      case 'sadd': {
        let data = this._memoryStore.get(msg.key)
        if (!data || !(data.value instanceof Set)) {
          data = {value: new Set(), expireAt: Infinity}
          this._memoryStore.set(msg.key, data)
        }
        const before = data.value.size
        for (const m of msg.members) data.value.add(m)
        return data.value.size - before
      }
      case 'smembers': {
        const data = this._memoryStore.get(msg.key)
        return data && data.value instanceof Set ? [...data.value] : []
      }
      case 'srem': {
        const data = this._memoryStore.get(msg.key)
        if (!data || !(data.value instanceof Set)) return 0
        let removed = 0
        for (const m of msg.members) if (data.value.delete(m)) removed++
        return removed
      }

      // --- Lock ---
      case 'lock': {
        const existing = this._memoryStore.get(msg.key)
        if (existing && existing.expireAt > Date.now()) return false
        const expireAt = Date.now() + (msg.ttl || 10) * 1000
        this._memoryStore.set(msg.key, {value: msg.owner ?? '1', expireAt})
        return true
      }
      case 'unlock': {
        const existing = this._memoryStore.get(msg.key)
        if (!existing || existing.expireAt <= Date.now() || existing.value !== msg.owner) return false
        this._memoryStore.delete(msg.key)
        return true
      }
      case 'extendLock': {
        const existing = this._memoryStore.get(msg.key)
        if (!existing || existing.expireAt <= Date.now() || existing.value !== msg.owner) return false
        existing.expireAt = Date.now() + (msg.ttl || 10) * 1000
        return true
      }

      // --- Pub/Sub ---
      case 'publish': {
        const workers = this._memorySubs.get(msg.channel)
        if (workers) {
          for (const wId of workers) {
            sendToWorker(cluster.workers[wId], {type: 'ipc:message', channel: msg.channel, message: msg.message})
          }
        }
        // Subscribers on the primary itself (cron jobs) have no worker id to be registered
        // under; they are served from the primary's own subscription map. Delivery is
        // deferred and the message copied, matching what a worker receives.
        const local = this._subs.get(msg.channel)
        if (local && local.size > 0) {
          const message = copy(msg.message)
          setImmediate(() => {
            for (const cb of local) this._deliver(msg.channel, cb, message)
          })
        }
        return undefined
      }
      case 'subscribe': {
        if (!this._memorySubs.has(msg.channel)) {
          this._memorySubs.set(msg.channel, new Set())
        }
        // msg.workerId is set by _handlePrimaryMessage for worker context
        if (msg.workerId) this._memorySubs.get(msg.channel).add(msg.workerId)
        return undefined
      }
      case 'unsubscribe': {
        if (this._memorySubs.has(msg.channel)) {
          this._memorySubs.get(msg.channel).delete(msg.workerId)
          if (this._memorySubs.get(msg.channel).size === 0) {
            this._memorySubs.delete(msg.channel)
          }
        }
        return undefined
      }
    }
    return null
  }

  _startGarbageCollector() {
    // Run every 5 minutes.
    // This is "lazy enough" not to impact CPU, but frequent enough to free memory.
    const interval = setInterval(
      () => {
        try {
          const now = Date.now()
          for (const [key, data] of this._memoryStore) {
            if (data.expireAt !== Infinity && now > data.expireAt) {
              this._memoryStore.delete(key)
            }
          }
        } catch (e) {
          console.error('[Odac IPC GC Error]', e)
        }
      },
      5 * 60 * 1000
    )

    // Allow process to exit even if this interval is running
    interval.unref()
  }

  /**
   * Tears down IPC resources. For Redis driver, disconnects clients.
   * For memory driver, clears stores and removes cluster listeners.
   */
  async close() {
    if (this.config.driver === 'redis') {
      for (const channel of this._redisBridges.keys()) this.removeAllListeners(channel)
      this._redisBridges.clear()
      if (this.subRedis) {
        await this.subRedis.quit().catch(() => {})
        this.subRedis = null
      }
      if (this.redis) {
        await this.redis.quit().catch(() => {})
        this.redis = null
      }
    } else if (cluster.isPrimary) {
      if (global.__odac_ipc_message_handler) {
        cluster.removeListener('message', global.__odac_ipc_message_handler)
        global.__odac_ipc_message_handler = null
      }
      if (global.__odac_ipc_exit_handler) {
        cluster.removeListener('exit', global.__odac_ipc_exit_handler)
        global.__odac_ipc_exit_handler = null
      }
      if (this._memoryStore) this._memoryStore.clear()
      if (this._memorySubs) this._memorySubs.clear()
    } else {
      // Worker: reject all pending requests so they don't hang
      for (const req of this._requests.values()) {
        clearTimeout(req.timeout)
        req.reject(new Error('IPC shutting down'))
      }
      this._requests.clear()
      this._subs.clear()
    }
    this.initialized = false
  }

  _handlePrimaryMessage(worker, msg) {
    const action = msg.type.replace('ipc:', '')

    // Inject worker context for subscribe/unsubscribe
    if (action === 'subscribe' || action === 'unsubscribe') {
      msg.workerId = worker.id
    }

    const response = this._executePrimaryAction(action, msg)

    if (msg.id) {
      sendToWorker(worker, {type: 'ipc:response', id: msg.id, data: response})
    }
  }
}

module.exports = new Ipc()
