# IPC (Inter-Process Communication)

Odac provides a built-in IPC system that allows your application workers to communicate with each other, share data, and sync states. It abstracts the underlying driver, allowing you to switch between in-memory (cluster) and Redis-based communication with a simple configuration change.

## Configuration

To configure the IPC system, update your project configuration. The default driver is `memory`.

```javascript
// config.js
module.exports = {
  // ...
  database: {
    // ... other dbs
    redis: {
      default: {
        // node-redis connection options
        // e.g., url: 'redis://user:pass@host:port'
      }
    }
  },
  ipc: {
    driver: 'memory', // Options: 'memory' or 'redis'
    redis: 'default'  // The name of the redis connection to use (if driver is 'redis')
  }
}
```

### Drivers

- **memory**: Uses Node.js `cluster` IPC. Ideal for single-server deployments. Data is stored in the Main/Primary process RAM and shared across workers via `process.send`.
- **redis**: Uses a Redis server. Ideal for multi-server/horizontal scaling deployments. Requires a configured Redis connection.

## Usage

You can access the IPC module via `Odac.Ipc`.

### Data Storage (Key-Value)

You can set, get, and delete values. These values are shared across all workers.

```javascript
// Set a value (with optional TTL in seconds)
await Odac.Ipc.set('maintenance_mode', true);
await Odac.Ipc.set('temp_cache', { foo: 'bar' }, 60);

// Get a value
const isMaintenance = await Odac.Ipc.get('maintenance_mode');

// Delete a value
await Odac.Ipc.del('maintenance_mode');
```

> [!NOTE]
> `get`, `set`, and `del` are asynchronous and return Promises.

### Pub/Sub (Messaging)

You can publish messages to channels and subscribe to them in other workers.

```javascript
// Subscribe to a channel
// Best practice: Subscribe in your app initialization or a Service Provider
await Odac.Ipc.subscribe('chat:global', (message) => {
  console.log('New chat message:', message);
});

// Publish a message
await Odac.Ipc.publish('chat:global', { user: 'Emre', text: 'Hello World' });
```

> [!TIP]
> When using `memory` driver, the subscription listener is registered in the current worker. When a message is published, it goes to the Main process and is then broadcasted to all subscribed workers.

### Atomic Counters

Use `incrBy` / `decrBy` to atomically increment or decrement a numeric key. These are safe to call from multiple workers simultaneously — no read-then-write race conditions.

```javascript
// Increment by 1 — returns new value
await Odac.Ipc.incrBy('page:views', 1)   // → 1
await Odac.Ipc.incrBy('page:views', 5)   // → 6

// Decrement
await Odac.Ipc.decrBy('page:views', 2)   // → 4

// Read the result
const views = await Odac.Ipc.get('page:views')  // → 4
```

> [!NOTE]
> Keys that don't exist yet are initialised to `0` before the operation.

---

### Hash Maps

Store and retrieve structured per-key data. Fields are merged on every `hset` call — existing fields not mentioned in the call are preserved.

```javascript
// Set fields (merged, not overwritten)
await Odac.Ipc.hset('user:42', {active_date: new Date(), last_ip: '1.2.3.4'})
await Odac.Ipc.hset('user:42', {score: 100})

// Retrieve all fields
const data = await Odac.Ipc.hgetall('user:42')
// → {active_date: ..., last_ip: '1.2.3.4', score: 100}
```

---

### Lists

Append items to a shared list and read them back in order. Useful for queues and event streams.

```javascript
// Append items to the right — returns new list length
await Odac.Ipc.rpush('jobs', {type: 'email', to: 'a@b.com'})
await Odac.Ipc.rpush('jobs', {type: 'sms'}, {type: 'push'})  // → 3

// Read a range (0-indexed, -1 = last item)
const pending = await Odac.Ipc.lrange('jobs', 0, -1)
```

---

### Sets

Maintain a collection of unique string members.

```javascript
// Add members
await Odac.Ipc.sadd('online', 'user:1', 'user:2', 'user:3')

// List all members
const online = await Odac.Ipc.smembers('online')  // → ['user:1', 'user:2', 'user:3']

// Remove members — returns number of members actually removed
await Odac.Ipc.srem('online', 'user:2')
```

---

### Distributed Locks

Acquire a mutex across all workers and servers before entering a critical section. The TTL prevents deadlocks if a process crashes while holding the lock.

```javascript
// Attempt to acquire the lock (TTL in seconds)
const acquired = await Odac.Ipc.lock('report:generate', 30)

if (!acquired) {
  // Another process is already running this — skip
  return
}

try {
  // Critical section — only one process runs this at a time
  await generateReport()
} finally {
  // Always release, even on error
  await Odac.Ipc.unlock('report:generate')
}
```

> [!TIP]
> With the `redis` driver, locks work across multiple servers — making them true distributed locks.

---

## Method Reference

| Method | Description |
|---|---|
| `set(key, value, ttl?)` | Store a value, with optional TTL in seconds |
| `get(key)` | Retrieve a value |
| `del(key)` | Delete a key |
| `incrBy(key, delta)` | Atomically increment a numeric key |
| `decrBy(key, delta)` | Atomically decrement a numeric key |
| `hset(key, fields)` | Merge fields into a hash map |
| `hgetall(key)` | Retrieve all fields of a hash map |
| `rpush(key, ...items)` | Append items to a list |
| `lrange(key, start, stop)` | Read a range of list items |
| `sadd(key, ...members)` | Add members to a set |
| `smembers(key)` | Get all members of a set |
| `srem(key, ...members)` | Remove members from a set |
| `lock(key, ttl)` | Acquire a mutex lock |
| `unlock(key)` | Release a mutex lock |
| `subscribe(channel, handler)` | Subscribe to a Pub/Sub channel |
| `publish(channel, message)` | Publish a message to a channel |
