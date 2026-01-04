const cluster = require('node:cluster')
const {EventEmitter} = require('node:events')

class Ipc extends EventEmitter {
  constructor() {
    super()
    this.driver = null
    this.config = {}
    this._requests = new Map() // For memory driver response tracking
    this._subs = new Map() // For memory driver subscriptions
  }

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
      const args = [key, JSON.stringify(value)]
      if (ttl > 0) args.push('EX', ttl)
      return this.redis.set(...args)
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

  async publish(channel, message) {
    if (this.config.driver === 'redis') {
      return this.redis.publish(channel, JSON.stringify(message))
    } else {
      return this._sendMemory('publish', {channel, message})
    }
  }

  async subscribe(channel, callback) {
    if (this.config.driver === 'redis') {
      if (!this.subRedis) {
        this.subRedis = this.redis.duplicate()
        await this.subRedis.connect()
        this.subRedis.on('message', (chan, msg) => {
          this.emit(chan, JSON.parse(msg))
        })
      }
      // Redis handles duplicate subscriptions gracefully (ignores them)
      await this.subRedis.subscribe(channel)
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
  }

  async unsubscribe(channel, callback) {
    if (this.config.driver === 'redis') {
      this.removeListener(channel, callback)
      // If no more listeners for this channel, unsubscribe from redis to save resources
      if (this.listenerCount(channel) === 0 && this.subRedis) {
        await this.subRedis.unsubscribe(channel)
      }
    } else {
      if (this._subs.has(channel)) {
        const callbacks = this._subs.get(channel)
        callbacks.delete(callback)
        if (callbacks.size === 0) {
          this._subs.delete(channel)
          this._sendMemory('unsubscribe', {channel})
        }
      }
    }
  }

  // --- Drivers ---

  async _initRedis() {
    // Assuming Odac has a Redis handler or we use a standard library.
    // Since strict requirements aren't given for Redis lib, assuming we use the one configured in Odac.Database or similar.
    // However, Odac.Database usually for SQL. Let's assume standard 'redis' package is available or we use a placeholder if not.
    // Checking package.json would be ideal, but for now implementing standard redis client usage.
    try {
      const Redis = require('redis')
      this.redis = Redis.createClient(Odac.Config.database?.redis?.[this.config.redis || 'default'] || {})
      await this.redis.connect()
    } catch (e) {
      console.error('IPC Redis Driver Error:', e)
      // Fallback to memory? or throw? For now just log.
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
            subs.forEach(cb => cb(msg.message))
          }
        }
      })
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
      const id = Date.now() + Math.random().toString(36).substr(2, 9)
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

  _handleDirectPrimaryCall(action, payload) {
    // Basic implementation for Primary process using itself
    if (action === 'set') {
      const expireAt = payload.ttl > 0 ? Date.now() + payload.ttl * 1000 : Infinity
      this._memoryStore.set(payload.key, {value: payload.value, expireAt})
      return true
    }
    if (action === 'get') {
      const data = this._memoryStore.get(payload.key)
      if (!data) return null
      if (data.expireAt !== Infinity && Date.now() > data.expireAt) {
        this._memoryStore.delete(payload.key)
        return null
      }
      return data.value
    }
    if (action === 'del') return this._memoryStore.delete(payload.key)
    if (action === 'publish') {
      const workers = this._memorySubs.get(payload.channel)
      if (workers) {
        workers.forEach(wId => {
          const w = cluster.workers[wId]
          if (w) w.send({type: 'ipc:message', channel: payload.channel, message: payload.message})
        })
      }
    }
    // subscribe on primary not deeply implemented to avoid complexity, usually workers listen.
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

  _handlePrimaryMessage(worker, msg) {
    const {type, id, key, value, ttl, channel, message} = msg
    const action = type.replace('ipc:', '')

    let response = null

    switch (action) {
      case 'set': {
        const expireAt = ttl > 0 ? Date.now() + ttl * 1000 : Infinity
        this._memoryStore.set(key, {value, expireAt})
        response = true
        break
      }
      case 'get': {
        const data = this._memoryStore.get(key)
        if (data) {
          if (data.expireAt !== Infinity && Date.now() > data.expireAt) {
            this._memoryStore.delete(key)
            response = null
          } else {
            response = data.value
          }
        } else {
          response = null
        }
        break
      }
      case 'del':
        response = this._memoryStore.delete(key)
        break
      case 'subscribe':
        if (!this._memorySubs.has(channel)) {
          this._memorySubs.set(channel, new Set())
        }
        this._memorySubs.get(channel).add(worker.id)
        break
      case 'unsubscribe':
        if (this._memorySubs.has(channel)) {
          this._memorySubs.get(channel).delete(worker.id)
          if (this._memorySubs.get(channel).size === 0) {
            this._memorySubs.delete(channel)
          }
        }
        break
      case 'publish': {
        // Relay to all subscribed workers
        const workers = this._memorySubs.get(channel)
        if (workers) {
          workers.forEach(wId => {
            // Don't echo back to sender if desired? Usually pub/sub receives own too if subbed.
            // Redis publishes to all subscribers.
            const w = cluster.workers[wId]
            if (w) w.send({type: 'ipc:message', channel, message})
          })
        }
        break
      }
    }

    if (id) {
      worker.send({type: 'ipc:response', id, data: response})
    }
  }
}

module.exports = new Ipc()
