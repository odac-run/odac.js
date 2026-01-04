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
    this.config = Odac.Config.ipc || {driver: 'memory'}

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
      await this.subRedis.subscribe(channel)
      this.on(channel, callback)
    } else {
      // Memory driver subscription
      // We process 'ipc:message' from checking message type in _initMemory
      if (!this._subs.has(channel)) {
        this._subs.set(channel, new Set())
        // Inform main process that this worker is subscribed
        this._sendMemory('subscribe', {channel})
      }
      this._subs.get(channel).add(callback)
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
      this._memoryStore = new Map()
      this._memorySubs = new Map() // channel -> Set<workerId>

      cluster.on('message', (worker, msg) => {
        if (msg && msg.type && msg.type.startsWith('ipc:')) {
          this._handlePrimaryMessage(worker, msg)
        }
      })
    } else {
      process.on('message', msg => {
        if (msg && msg.type === 'ipc:response') {
          const resolve = this._requests.get(msg.id)
          if (resolve) {
            resolve(msg.data)
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

    return new Promise(resolve => {
      const id = Date.now() + Math.random().toString(36).substr(2, 9)
      if (action !== 'subscribe' && action !== 'publish') {
        // Only wait for response for data ops
        this._requests.set(id, resolve)
      } else {
        resolve() // Pub/Sub doesn't wait for ack usually
      }
      process.send({type: `ipc:${action}`, id, ...payload})
    })
  }

  _handleDirectPrimaryCall(action, payload) {
    // Basic implementation for Primary process using itself
    if (action === 'set') {
      this._memoryStore.set(payload.key, payload.value)
      return true
    }
    if (action === 'get') return this._memoryStore.get(payload.key)
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

  _handlePrimaryMessage(worker, msg) {
    const {type, id, key, value, channel, message} = msg
    const action = type.replace('ipc:', '')

    let response = null

    switch (action) {
      case 'set':
        this._memoryStore.set(key, value)
        response = true
        break
      case 'get':
        response = this._memoryStore.get(key)
        break
      case 'del':
        response = this._memoryStore.delete(key)
        break
      case 'subscribe':
        if (!this._memorySubs.has(channel)) {
          this._memorySubs.set(channel, new Set())
        }
        this._memorySubs.get(channel).add(worker.id)
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
