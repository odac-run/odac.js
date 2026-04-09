# Read-Through Cache

At high traffic, repeatedly querying the same data — blog posts, product listings, settings, categories — generates redundant database round-trips. A page with 10,000 daily visitors reading the same 50 posts means 10,000 identical `SELECT` queries.

ODAC's **Read-Through Cache** solves this by caching `SELECT` results in `Odac.Ipc` and serving subsequent requests from memory. The only change to your code is adding `.cache()` to the chain.

```javascript
// Without cache — 1 DB query per request
const posts = await Odac.DB.posts.where('active', true).select('id', 'title')

// With cache — 1 DB query per TTL window, for all requests combined
const posts = await Odac.DB.posts.cache(60).where('active', true).select('id', 'title')
```

---

## How It Works

**Architecture: Ipc-Backed, Driver-Agnostic**

All cached data is stored in `Odac.Ipc`. The active IPC driver determines the scaling model:

| Driver | Scope | When to use |
|---|---|---|
| `memory` (default) | Single machine — all workers share cache via Primary process | Single-server deployments |
| `redis` | Multi-machine — all servers share cache in Redis | Horizontal scaling behind a load balancer |

```
// Memory driver (default)
Worker 1 ─┐
Worker 2 ─┼──→ Primary (Ipc memory store) ← cache HIT: O(1) return
Worker N ─┘                                ← cache MISS: DB query → store → return

// Redis driver
Server A ─┐
Server B ─┼──→ Redis (Ipc state) ← shared cache across all servers
Server C ─┘
```

**Cache Key Generation**

Each query is identified by a SHA-256 hash of its compiled SQL and bindings. Two identical queries — regardless of which worker or server generates them — always resolve to the same cache key.

```
rc:{connection}:{table}:{sha256(sql + bindings)}
```

**Automatic Invalidation**

Any `insert()`, `update()`, `delete()`, or `truncate()` on a table automatically purges all cached queries for that table. You never need to manually invalidate after a write — ODAC handles it.

```javascript
// This update automatically clears all cached queries on the 'posts' table
await Odac.DB.posts.where({id: 5}).update({title: 'New Title'})
```

**Cross-Table Invalidation (JOIN queries)**

When a cached query includes `JOIN` clauses, ODAC automatically registers the cache key in all joined tables' indexes. This means a write to any table involved in the query triggers invalidation.

```javascript
// This query is registered in BOTH 'posts' and 'users' cache indexes
const data = await Odac.DB.posts
  .cache(60)
  .join('users', 'posts.user_id', '=', 'users.id')
  .select('posts.title', 'users.name')

// Writing to 'users' invalidates the cached join query above — no stale data
await Odac.DB.users.where({id: 1}).update({name: 'New Name'})
```

This works with `join()`, `leftJoin()`, `rightJoin()`, and aliased tables (`users as u`).

---

## Basic Usage

### Cache with TTL

Pass a TTL (in seconds) to `.cache()`. The result is served from cache for that duration, then re-fetched from the database on the next request.

```javascript
// Cache for 60 seconds
const posts = await Odac.DB.posts.cache(60).where('active', true).select('id', 'title')

// Cache for 5 minutes (default TTL from config)
const post = await Odac.DB.posts.cache().where({id: 5}).first()

// Cache a count
const total = await Odac.DB.posts.cache(300).where('active', true).count()
```

### Named Connections

```javascript
// Default connection
const posts = await Odac.DB.posts.cache(60).select('id', 'title')

// Named connection: 'analytics'
const stats = await Odac.DB.analytics.events.cache(120).where('date', today).select()
```

---

## Manual Invalidation

### Table-Level Clear

Purge all cached queries for a table:

```javascript
// Via table proxy
await Odac.DB.posts.cache.clear()

// Via global accessor (useful in background jobs or service classes)
await Odac.DB.cache.clear('default', 'posts')

// Named connection
await Odac.DB.cache.clear('analytics', 'events')
```

---

## Automatic Invalidation on Write

You do not need to call `.cache.clear()` after writes. ODAC intercepts all write operations on the proxy and invalidates the table cache automatically.

| Operation | Cache invalidated? |
|---|---|
| `insert()` | ✅ Yes |
| `update()` | ✅ Yes |
| `delete()` | ✅ Yes |
| `del()` | ✅ Yes |
| `truncate()` | ✅ Yes |
| `buffer.insert()` | ❌ No — buffer writes are deferred; invalidate manually if needed |

> **Note on `buffer` + `cache`:** If you use the Write-Behind Cache (`buffer`) alongside the Read-Through Cache, the buffer's deferred writes do not trigger automatic invalidation. Call `Odac.DB.posts.cache.clear()` after a `buffer.flush()` if you need the cache to reflect the latest state immediately.

---

## Configuration

Add a `cache` section to your `odac.json`:

```json
{
  "cache": {
    "ttl": 300,
    "maxKeys": 10000
  }
}
```

| Option | Default | Description |
|---|---|---|
| `ttl` | `300` | Default cache duration in seconds when `.cache()` is called without an argument |
| `maxKeys` | `10000` | Maximum number of cached query keys per table. New entries are skipped once the limit is reached — protects against unbounded memory growth |

---

## Horizontal Scaling

To share cache state across multiple servers, switch the `ipc` driver to `redis`:

```json
{
  "ipc": {
    "driver": "redis",
    "redis": "default"
  }
}
```

With the Redis driver active, all servers share the same cache. A cache invalidation triggered by a write on Server A is immediately visible to Server B. No code changes are required in your application.

---

## When to Use (and Not Use)

**Use Read-Through Cache for:**
- Blog posts, articles, product listings
- Navigation menus, category trees, tag lists
- Site settings, feature flags, configuration values
- Any data that is read frequently and changes infrequently

**Do not use for:**
- Data that must always reflect the latest DB state (e.g., account balances, inventory counts)
- Queries with user-specific filters where caching would leak data across users
- Queries inside transactions where consistency is critical

> [!TIP]
> Combine with the Write-Behind Cache for maximum throughput: use `.buffer` for high-frequency writes (view counters, last-active timestamps) and `.cache()` for high-frequency reads (post listings, settings). They operate independently and complement each other.

---

## Guarantees

| Scenario | Behaviour |
|---|---|
| Cache MISS | DB query executes, result is stored in Ipc with TTL |
| Cache HIT | Result returned from Ipc — no DB query |
| TTL expired | Next request triggers a fresh DB query and re-caches |
| `insert/update/delete` | All cached queries for that table are purged automatically |
| Worker crash | No data loss — cache state is in Primary process (memory) or Redis |
| `maxKeys` reached | New cache entries are skipped; existing entries still served |
| Ipc not initialized | Invalidation is a no-op — safe for environments without Ipc setup |
