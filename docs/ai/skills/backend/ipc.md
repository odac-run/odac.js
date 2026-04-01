---
name: backend-ipc-skill
description: ODAC inter-process communication guidance for memory and Redis drivers, shared state, and distributed coordination.
metadata:
  tags: backend, ipc, redis, cluster, distributed-state, synchronization
---

# Backend IPC (Inter-Process Communication) Skill

ODAC provides a built-in IPC system to share data and sync states across application workers or multiple servers.

## Architectural Approach
IPC abstracts the underlying driver, allowing seamless transition between `memory` (Node.js cluster) and `redis` (multi-server scaling).

## Core Rules
1.  **Drivers**:
    -   `memory`: Shared across local workers via Main process (Default).
    -   `redis`: Shared across multiple servers/clusters.
2.  **State Sharing**: Use `Odac.Ipc` for global key-value storage.
3.  **Messaging**: Use Pub/Sub for worker-to-worker communication.

## Reference Patterns

### 1. Key-Value Storage
```javascript
// Set value with optional TTL (seconds)
await Odac.Ipc.set('maintenance_mode', true)
await Odac.Ipc.set('cache_key', {data: 123}, 60)

// Get value
const status = await Odac.Ipc.get('maintenance_mode')

// Delete value
await Odac.Ipc.del('maintenance_mode')
```

### 2. Atomic Counters
```javascript
// Increment / decrement a numeric key (returns new value)
await Odac.Ipc.incrBy('page:views', 1)    // → 1
await Odac.Ipc.incrBy('page:views', 5)    // → 6
await Odac.Ipc.decrBy('page:views', 2)    // → 4

// Read current value
const views = await Odac.Ipc.get('page:views')  // → 4
```

### 3. Hash Maps
```javascript
// Set / merge fields (last-write-wins per field)
await Odac.Ipc.hset('user:1', {active_date: new Date(), last_ip: '1.2.3.4'})
await Odac.Ipc.hset('user:1', {score: 42})

// Get all fields
const fields = await Odac.Ipc.hgetall('user:1')
// → {active_date: ..., last_ip: '1.2.3.4', score: 42}
```

### 4. Lists
```javascript
// Append items to the right (returns new length)
await Odac.Ipc.rpush('events', {type: 'click'}, {type: 'view'})  // → 2

// Read range (inclusive, -1 = last item)
const items = await Odac.Ipc.lrange('events', 0, -1)
```

### 5. Sets
```javascript
// Add members
await Odac.Ipc.sadd('online_users', 'user:1', 'user:2')

// Get all members
const users = await Odac.Ipc.smembers('online_users')  // → ['user:1', 'user:2']

// Remove members (returns removed count)
await Odac.Ipc.srem('online_users', 'user:1')
```

### 6. Distributed Locks
```javascript
// Acquire lock with TTL in seconds (returns true if acquired, false if already held)
const acquired = await Odac.Ipc.lock('flush:lock', 10)
if (!acquired) return  // another process is holding the lock

try {
  // ... critical section ...
} finally {
  await Odac.Ipc.unlock('flush:lock')
}
```

### 7. Pub/Sub Messaging
```javascript
// Subscribe to a channel
await Odac.Ipc.subscribe('notifications', (msg) => {
  console.log('Received:', msg)
})

// Publish a message from any worker
await Odac.Ipc.publish('notifications', {type: 'alert', text: 'System update'})
```

## Configuration
In `odac.json` or a config provider:
```json
{
  "ipc": {
    "driver": "redis",
    "redis": "default"
  }
}
```

## Best Practices
- **Async First**: All IPC operations are asynchronous.
- **TTL Usage**: Always set a TTL for temporary cache data to prevent memory bloat.
- **Scaling**: Switch to `redis` driver when deploying across multiple containers or servers. No application code changes required.
- **Locks**: Always release locks in a `finally` block to prevent deadlocks.
- **Sets for indexes**: Use `sadd/smembers/srem` to track active keys — avoids expensive SCAN operations.
- **Atomic counters over get+set**: Use `incrBy`/`decrBy` instead of `get` → compute → `set` to prevent race conditions.
