# Write-Behind Cache

At high traffic, individual database writes for common operations — like incrementing a page view counter or stamping a user's last-active date — quickly saturate your connection pool. One million page views = one million `UPDATE` queries.

ODAC's **Write-Behind Cache** solves this by buffering writes in memory and flushing them to the database in efficient batches. The only change to your code is adding `.buffer` to the chain.

```javascript
// Without buffer — 1 DB write per request
await Odac.DB.posts.where(postId).update({views: Odac.DB.raw('views + 1')})

// With buffer — 1 DB write per flush interval, for all requests combined
await Odac.DB.posts.buffer.where(postId).increment('views')
```

---

## How It Works

**Architecture: Ipc-Backed, Driver-Agnostic**

All buffered state is held in `Odac.Ipc`. The active IPC driver determines the scaling model:

| Driver | Scope | When to use |
|---|---|---|
| `memory` (default) | Single machine — cluster workers share state via Primary process | Single-server deployments |
| `redis` | Multi-machine — all servers share state in Redis | Horizontal scaling behind a load balancer |

```
// Memory driver (default)
Worker 1 ─┐
Worker 2 ─┼──→ Primary (Ipc memory store) ──→ DB (batch flush every 5s)
Worker N ─┘

// Redis driver
Server A ─┐
Server B ─┼──→ Redis (Ipc state) ──→ DB (flush — distributed lock prevents duplicate writes)
Server C ─┘
```

A **distributed lock** (`Ipc.lock`) guarantees that only one process or server flushes at a time, even across multiple machines.

**Crash Safety via LMDB Checkpoint** *(memory driver only)*

Every 30 seconds, pending buffer data is written to the local LMDB store. On a crash and restart, ODAC recovers this checkpoint and flushes it to the database before accepting any traffic. When using the Redis driver, Redis itself provides durability — LMDB checkpoints are skipped.

---

## Three Operations

### 1. Counter Increment

Accumulates numeric deltas. Multiple increments to the same column merge into a single `UPDATE col = col + delta` at flush time.

```javascript
// Increment by 1 (default)
await Odac.DB.posts.buffer.where(postId).increment('views')

// Increment by a custom amount
await Odac.DB.posts.buffer.where(postId).increment('likes', 5)
await Odac.DB.downloads.buffer.where(fileId).increment('count', 3)
```

**Read the current value** — returns `DB base + pending delta`, always accurate:

```javascript
const currentViews = await Odac.DB.posts.buffer.where(postId).get('views')
// → 4527 (e.g., 4500 in DB + 27 buffered, not yet flushed)
```

**Composite primary key:**

```javascript
await Odac.DB.post_stats.buffer
  .where({post_id: 123, date: '2026-04-01'})
  .increment('views')
```

---

### 2. Last-Write-Wins Update

Buffers column SET operations for a row. If the same row is updated multiple times before a flush, the values are merged — the latest value for each column wins. The entire pending set for a row is written in a single `UPDATE` at flush.

```javascript
// 50 requests update the same user → 1 UPDATE at flush
await Odac.DB.users.buffer.where(userId).update({active_date: new Date()})
await Odac.DB.users.buffer.where(userId).update({last_ip: req.ip})
// → UPDATE users SET active_date = ?, last_ip = ? WHERE id = ?  (one query for all 50 requests)
```

**Composite primary key:**

```javascript
await Odac.DB.user_prefs.buffer
  .where({user_id: 1, pref_key: 'theme'})
  .update({pref_value: 'dark'})
```

**Combine with increment** — both flush in the same cycle:

```javascript
await Odac.DB.users.buffer.where(userId).increment('login_count')
await Odac.DB.users.buffer.where(userId).update({active_date: new Date(), last_ip: req.ip})
```

---

### 3. Batch Insert

Queues rows in memory and inserts them in chunks of 1,000 at flush time. Ideal for audit logs, analytics events, and activity streams where individual inserts are wasteful.

```javascript
await Odac.DB.activity_log.buffer.insert({
  user_id: userId,
  action: 'page_view',
  meta: req.url,
  created_at: Date.now()
})
```

The queue auto-flushes immediately if it exceeds `maxQueueSize` (default: 10,000 rows).

---

## Manual Flush

Force an immediate flush for a specific table or for all buffered tables:

```javascript
// Flush a single table
await Odac.DB.posts.buffer.flush()

// Flush all buffered tables across all connections
await Odac.DB.buffer.flush()
```

> Graceful shutdown (`SIGTERM`/`SIGINT`) triggers a final flush automatically before the DB connections are closed. You do not need to call `flush()` in your shutdown handlers.

---

## Configuration

Add a `buffer` section to your `odac.json`:

```json
{
  "buffer": {
    "flushInterval": 5000,
    "checkpointInterval": 30000,
    "maxQueueSize": 10000,
    "primaryKey": "id"
  }
}
```

| Option | Default | Description |
|---|---|---|
| `flushInterval` | `5000` | How often (ms) to flush pending data to the database |
| `checkpointInterval` | `30000` | How often (ms) to write a crash-recovery checkpoint to LMDB *(memory driver only)* |
| `maxQueueSize` | `10000` | Auto-flush the insert queue when it reaches this many rows |
| `primaryKey` | `"id"` | Default primary key column name for scalar `where()` values |

---

## Horizontal Scaling

To share buffer state across multiple servers, switch the `ipc` driver to `redis`:

```json
{
  "ipc": {
    "driver": "redis",
    "redis": "default"
  }
}
```

With the Redis driver active:
- All `increment`, `update`, and `insert` operations go to Redis atomically.
- Any server can trigger a `flush()` — the distributed lock ensures no server writes twice.
- LMDB checkpoints are skipped (Redis persistence provides the durability guarantee).

No code changes are required in your application. The `.buffer` API is identical regardless of driver.

---

## Named Database Connections

The buffer respects your multi-connection configuration. Access it via the named connection, then the table:

```javascript
// Default connection
await Odac.DB.posts.buffer.where(postId).increment('views')

// Named connection: 'analytics'
await Odac.DB.analytics.events.buffer.insert({type: 'click', target: '#cta'})
```

---

## Guarantees

| Scenario | Behaviour |
|---|---|
| Worker crash | No data loss — all state is in the Primary process (memory) or Redis |
| Primary crash | Pending data recovered from LMDB checkpoint on next startup *(memory driver)* |
| Server crash (Redis) | Pending data is durable in Redis — recovered on next flush cycle |
| DB flush error | Data is retained in Ipc and retried on the next flush cycle |
| Graceful shutdown | Automatic final flush before connections close |
| `get()` after `increment()` | Returns base + buffered delta — always accurate, no extra DB read |
| Concurrent workers | Primary serializes all writes (memory) or Redis atomic ops prevent races |
| Multiple servers | Distributed lock guarantees exactly one flush at a time |

---

## When to Use (and Not Use)

**Use Write-Behind Cache for:**
- Page/post view counters
- Download counters, like/upvote counts
- User last-active timestamps, last IP
- Activity logs, analytics events, audit trails
- Any write that is not immediately safety-critical and occurs on every request

**Do not use for:**
- Operations where the write must be visible to the *same* request that triggered it
- Inserts that return generated IDs you need immediately (use direct `insert()`)

> [!WARNING]
> **Never use Write-Behind Cache for financial or safety-critical operations** — payment records, order confirmations, balance changes, inventory decrements, or any write where data loss or a delayed flush would have real-world consequences. The buffer does not guarantee that data reaches the database before a crash. Use direct database transactions for anything that matters immediately.
