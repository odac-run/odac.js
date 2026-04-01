---
name: backend-database-skill
description: High-performance ODAC database querying patterns including the Write-Behind Cache for counters, last-write-wins updates, and buffered batch inserts.
metadata:
  tags: backend, database, query-builder, sql, write-behind-cache, performance, security
---

# Backend Database Skill

High-performance database operations using the ODAC Query Builder and Write-Behind Cache.

## Principles
1.  **Directness**: Avoid ORM overhead. Use fluent Query Builder.
2.  **Safety**: Always use parameterized queries (built-in).
3.  **Efficiency**: Index foreign keys. No `SELECT *`.
4.  **Write Coalescing**: Use `buffer` for high-frequency writes to avoid DB saturation.

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

The `buffer` API intercepts writes and holds them in the Primary process memory, then flushes to DB in batches via a configurable interval. The only difference from the standard API is `.buffer` in the chain.

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
1.  **Cluster-Safe**: Primary process holds all state. Workers send via IPC. No race conditions.
2.  **Crash-Safe**: LMDB checkpoint written every 30s. On restart, pending data is recovered and flushed before serving traffic.
3.  **get() is authoritative**: Always returns `DB base + buffered delta`. Never stale.
4.  **Flush on shutdown**: `Database.close()` triggers a final flush automatically — no data loss on graceful shutdown.
5.  **Error resilience**: If a flush fails, data is retained for the next cycle. Never lost silently.

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

See: [migrations.md](./migrations.md) | [write-behind-cache user docs](../../../backend/08-database/05-write-behind-cache.md)
