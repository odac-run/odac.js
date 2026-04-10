---
name: backend-database-skill
description: High-performance ODAC database querying patterns including the Read-Through Cache for SELECT results and the Write-Behind Cache for counters, last-write-wins updates, and buffered batch inserts.
metadata:
  tags: backend, database, query-builder, sql, read-through-cache, write-behind-cache, performance, security
---

# Backend Database Skill

High-performance database operations using the ODAC Query Builder, Read-Through Cache, and Write-Behind Cache.

## Principles
1.  **Directness**: Avoid ORM overhead. Use fluent Query Builder.
2.  **Safety**: Always use parameterized queries (built-in).
3.  **Efficiency**: Index foreign keys. No `SELECT *`.
4.  **Read Caching**: Use `cache()` for frequently-read, rarely-changed data.
5.  **Write Coalescing**: Use `buffer` for high-frequency writes to avoid DB saturation.

## Query Builder Patterns
```javascript
const user = await Odac.DB.users
  .select('id', 'name', 'email')
  .where('status', 'active')
  .first()

await Odac.DB.posts.insert({title: 'Hello', user_id: 1})

await Odac.DB.users.where('id', 1).update({last_login: new Date()})

const count = await Odac.DB.users.where('active', true).count() // → Number
```

## Read-Through Cache (`cache`)

The `cache()` API stores SELECT results in `Odac.Ipc` and serves subsequent requests from memory. Cache keys are SHA-256 hashes of the compiled SQL + bindings — identical queries always hit the same key.

### When to suggest `cache`

Propose the Read-Through Cache when the data meets **all three** of these criteria:
1. **High read frequency** — the same query runs on many requests.
2. **Low write frequency** — the data changes infrequently (minutes to hours between updates).
3. **Not user-specific** — the same result is safe to serve to all users (no per-user filtering that could leak data).

**Typical candidates:**
- Blog posts, articles, product listings
- Navigation menus, category trees, tag lists
- Site settings, feature flags, configuration values
- Public API responses that don't vary by user

**Do NOT suggest `cache` for:**
- Queries with user-specific WHERE clauses (data leakage risk)
- Account balances, inventory counts, or anything requiring real-time accuracy
- Queries inside transactions where consistency is critical

### API

```javascript
// Cache with explicit TTL (seconds)
const posts = await Odac.DB.posts.cache(60).where('active', true).select('id', 'title')

// Cache with default TTL (from config, default 300s)
const post = await Odac.DB.posts.cache().where({id: 5}).first()

// Named connection
const stats = await Odac.DB.analytics.events.cache(120).where('date', today).select()

// Manual invalidation — table-level
await Odac.DB.posts.cache.clear()

// Global invalidation
await Odac.DB.cache.clear('default', 'posts')
```

### Automatic Invalidation

`insert()`, `update()`, `delete()`, `del()`, and `truncate()` automatically purge all cached queries for that table. No manual `.cache.clear()` needed after writes.

```javascript
// This update automatically clears all cached queries on 'posts'
await Odac.DB.posts.where({id: 5}).update({title: 'New Title'})
```

**Cross-table (JOIN) invalidation:** When a cached query includes `JOIN` clauses, the cache key is registered in all joined tables' indexes. A write to any table involved in the query triggers invalidation automatically.

```javascript
// Cached in both 'posts' and 'users' indexes
await Odac.DB.posts.cache(60).join('users', 'posts.user_id', '=', 'users.id').select(...)

// Writing to 'users' invalidates the cached join query above
await Odac.DB.users.where({id: 1}).update({name: 'New Name'})
```

> **`buffer` + `cache` interaction:** `buffer` writes are deferred and do NOT trigger automatic invalidation. Call `Odac.DB.posts.cache.clear()` after a `buffer.flush()` if the cache must reflect the latest state immediately.

### Read-Through Cache — Key Rules
1.  **Ipc-Backed**: Cache state goes through `Odac.Ipc`. Memory driver = Primary holds state; Redis driver = Redis holds state.
2.  **Horizontally Scalable**: With Redis driver, all servers share the same cache. Invalidation on one server is immediately visible to all others.
3.  **TTL is the safety net**: Even without explicit invalidation, cached data expires after TTL seconds.
4.  **maxKeys guard**: Once `maxKeys` is reached for a table, new entries are skipped — existing cache still served. Prevents unbounded memory growth.
5.  **Ipc-safe**: If `Odac.Ipc` is not initialized (e.g., in isolated test environments), invalidation is a no-op — never throws.

## Configuration (`odac.json`)
```json
{
  "cache": {
    "ttl": 300,
    "maxKeys": 10000
  }
}
```

## ID Strategy (NanoID)
1.  **Schema-Driven**: Define string IDs with `type: 'nanoid'` in `schema/*.js`.
2.  **Auto Generation**: On `insert()`, ODAC auto-generates missing nanoid fields.
3.  **No Override**: If ID is explicitly provided, ODAC preserves it.
4.  **Bulk Safe**: Auto-generation works for both single and bulk inserts.

```javascript
// schema/posts.js
module.exports = {
  columns: {
    id: {type: 'nanoid', primary: true},
    title: {type: 'string', length: 255}
  }
}

// ID is generated automatically
await Odac.DB.posts.insert({title: 'Hello'})
```

## Write-Behind Cache (`buffer`)

The `buffer` API routes all writes through `Odac.Ipc`. The active IPC driver determines the scaling model — no code changes required when switching drivers.

- **`memory` driver** (default): Primary process holds all state; workers communicate via cluster IPC.
- **`redis` driver**: State lives in Redis — works transparently across multiple servers.

### When to suggest `buffer`

Propose the Write-Behind Cache when the user's write operation meets **all three** of these criteria:
1. **High frequency** — the same column or row is written on many requests (counters, timestamps, last-seen values).
2. **Eventual consistency is acceptable** — a few seconds' delay before the value reaches the DB is fine.
3. **Not safety-critical** — losing the buffered value in a crash has no financial, legal, or user-facing consequence.

**Typical candidates:**
- Page / post / download view counters (`increment`)
- Like, upvote, share counts (`increment`)
- User last-active timestamp, last IP (`update`)
- Analytics events, audit logs, activity streams (`insert`)
- Score accumulators, play counts, rating tallies (`increment`)

**Do NOT suggest `buffer` for:**
- Payments, charges, refunds, or any monetary operation
- Order creation, inventory decrements
- Anything the same request needs to read back immediately
- Inserts that return a generated ID the caller uses

When in doubt, use a direct DB call.

**Three operation types:**

### 1. Counter Increment (Write Coalescing)
Accumulates deltas — multiple increments merge into one `UPDATE col = col + delta`.
`get()` returns `base + pending delta` (always current, no DB read needed).
```javascript
// Increment — returns current total (DB base + buffered delta)
const views = await Odac.DB.posts.buffer.where(postId).increment('views')
const likes = await Odac.DB.posts.buffer.where(postId).increment('likes', 5)

// Read buffered counter (no extra DB round-trip)
const current = await Odac.DB.posts.buffer.where(postId).get('views')

// Composite key
await Odac.DB.post_stats.buffer.where({post_id: 1, date: '2026-04-01'}).increment('views')
```

### 2. Last-Write-Wins Update (Field Coalescing)
Multiple updates to the same row merge column maps — 50 requests = 1 `UPDATE` at flush.
```javascript
// Columns are merged per row: first update + second update = single UPDATE at flush
await Odac.DB.users.buffer.where(userId).update({active_date: new Date()})
await Odac.DB.users.buffer.where(userId).update({last_ip: req.ip})
// → UPDATE users SET active_date = ?, last_ip = ? WHERE id = ?  (one query)
```

### 3. Batch Insert (Queue)
Rows accumulate in memory; flushed in chunks of 1000. Auto-flushes when `maxQueueSize` is reached.
```javascript
await Odac.DB.activity_log.buffer.insert({user_id: userId, action: 'page_view', meta: url})
```

### Manual Flush
```javascript
await Odac.DB.posts.buffer.flush()   // flush this table only
await Odac.DB.buffer.flush()         // flush everything
```

## Write-Behind Cache — Key Rules
1.  **Ipc-Backed**: All buffer state goes through `Odac.Ipc`. Memory driver = Primary holds state; Redis driver = Redis holds state.
2.  **Horizontally Scalable**: With Redis driver, multiple servers share the same buffer state. Distributed lock (`Ipc.lock`) prevents duplicate flushes.
3.  **Crash-Safe (memory)**: LMDB checkpoint written every 30s. On restart, pending data is recovered and flushed before serving traffic.
4.  **Crash-Safe (redis)**: Redis persistence provides durability. LMDB checkpoints are skipped.
5.  **get() is authoritative**: Always returns `DB base + buffered delta`. Never stale.
6.  **Flush on shutdown**: `Database.close()` triggers a final flush automatically — no data loss on graceful shutdown.
7.  **Error resilience**: If a flush fails, data is retained in Ipc for the next cycle. Never lost silently.
8.  **NEVER use buffer for safety-critical writes**: Payment records, order confirmations, balance changes, inventory decrements — anything where data loss has real-world consequences MUST use direct DB transactions. The buffer does not guarantee delivery before a crash.

## Configuration (`odac.json`)
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

## Migration Awareness
1.  **Schema-First**: Structural DB changes must be defined in `schema/*.js`.
2.  **Auto-Migrate**: Migrations run automatically at startup from `Database.init()`.
3.  **Cluster-Safe**: Migration execution is limited to primary process (`cluster.isPrimary`).
4.  **Indexes**: Keep index definitions in schema so add/drop is managed automatically.
5.  **Data Changes**: Use `migration/*.js` only for one-time data transformation.

See: [migrations.md](./migrations.md) | [write-behind-cache user docs](../../../backend/08-database/05-write-behind-cache.md) | [read-through-cache user docs](../../../backend/08-database/06-read-through-cache.md)
