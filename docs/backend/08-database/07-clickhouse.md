# ClickHouse Support (Analytics)

ClickHouse is a columnar **OLAP** database, purpose-built for analytical queries over large,
append-heavy datasets (events, logs, metrics). ODAC integrates it as a **secondary, append-only
connection** that sits alongside your transactional MySQL/PostgreSQL/SQLite database.

Because ClickHouse's data model is fundamentally different from a row-store OLTP database, the
integration is **intentionally scoped** — it supports what ClickHouse does well and deliberately
leaves out patterns that are anti-patterns on ClickHouse.

## Installation

ClickHouse is served by a dedicated adapter (not Knex). Install the official driver:

```bash
npm install @clickhouse/client
```

## Configuration

```json
{
  "database": {
    "default": { "type": "mysql", "host": "localhost", "database": "main_db" },
    "analytics": {
      "type": "clickhouse",
      "host": "localhost",
      "port": 8123,
      "user": "default",
      "password": "",
      "database": "analytics"
    }
  }
}
```

Supported options: `host`, `port` (default `8123`), `user`, `password`, `database`, `protocol`
(default `http`), or a single `url` (e.g. `"url": "https://my-instance.clickhouse.cloud:8443"`)
as an alternative to host/port.

## Schema-First Migrations

Your `schema/` files are the single source of truth for ClickHouse too. Place ClickHouse tables
under the named connection's subdirectory (`schema/analytics/events.js`). ClickHouse's CREATE TABLE
needs a table **engine** and a **sorting key**, so the schema format is extended with a few
ClickHouse-only fields (ignored by SQL engines):

```javascript
// schema/analytics/events.js
module.exports = {
  engine: 'MergeTree',                        // default 'MergeTree'; pass 'ReplacingMergeTree(ver)' etc. verbatim
  orderBy: ['created_at', 'id'],              // sorting key (required by MergeTree; defaults to tuple())
  partitionBy: 'toYYYYMM(created_at)',        // optional partitioning expression
  ttl: 'created_at + INTERVAL 30 DAY',        // optional table-level retention (raw TTL expression)
  settings: 'index_granularity = 8192',       // optional raw SETTINGS clause

  columns: {
    id:         { type: 'nanoid' },
    user_id:    { type: 'bigInteger' },
    event:      { type: 'string' },
    payload:    { type: 'json' },
    source:     { type: 'string', nullable: true },
    // Per-column TTL: expires just this value (reset to default), not the whole row
    token:      { type: 'string', default: '', ttl: 'created_at + INTERVAL 7 DAY' },
    created_at: { type: 'datetime', nullable: false }
  },

  // Insert-only seeding (optional)
  seedKey: 'event',
  seed: [{ event: 'signup', user_id: 0, id: '', created_at: '2026-01-01 00:00:00' }]
}
```

Run migrations as usual:

```bash
npx odac migrate            # creates tables / adds new columns
npx odac migrate:status     # dry-run: shows pending changes
npx odac migrate --db=analytics   # target a single connection
```

### Nullable semantics differ

> **Important:** SQL engines treat an unspecified `nullable` as **nullable**. ClickHouse columns
> are **NOT NULL by default**. To stay predictable, a ClickHouse column is nullable **only** when
> you set `nullable: true`. Everything else is emitted as a plain (non-null) type.

### Data retention with TTL

ClickHouse can expire data automatically. ODAC exposes both TTL levels as raw expressions passed
through verbatim — you own the syntax, ODAC just places the clause correctly (`ENGINE → PARTITION
BY → ORDER BY → TTL → SETTINGS`).

- **Table-level** `ttl` — a whole-row retention policy. Supports the full ClickHouse tail
  (`DELETE` / `TO DISK` / `TO VOLUME` / `WHERE` / `GROUP BY`):

  ```javascript
  ttl: 'created_at + INTERVAL 90 DAY DELETE WHERE status = 2'
  ```

- **Column-level** `ttl` — expires a single column's value (reset to its default), not the row.
  Handy for dropping sensitive fields while keeping the analytical record:

  ```javascript
  token: { type: 'string', default: '', ttl: 'created_at + INTERVAL 7 DAY' }
  ```

> TTL applies to **MergeTree-family engines only**. On other engines the clause is silently
> omitted and the `ttl` field is ignored.

**Table-level TTL is auto-synced.** Change or remove `ttl` in the schema file and the next
`migrate` issues `ALTER TABLE … MODIFY TTL …` (or `… REMOVE TTL`) automatically. Three things to
know about how the diff works:

- It compares against the expression ODAC **last applied** (recorded in `_odac_migrations`), not
  the live table DDL. ClickHouse normalizes TTL expressions internally (`INTERVAL 30 DAY` becomes
  `toIntervalDay(30)`), so introspection-based comparison would falsely re-apply on every boot.
  Consequence: a TTL added or changed **manually** (out-of-band `ALTER`) is invisible to the diff.
- Keep the schema expression **byte-stable** — rewriting `30 DAY` as `720 HOUR` is a "change" and
  triggers a re-apply, even though the policy is equivalent.
- `MODIFY TTL` materializes the new policy on **existing parts** (a background mutation). On very
  large tables this can be expensive — plan TTL changes accordingly.

**Column-level TTL** is applied at `CREATE TABLE` / `ADD COLUMN` only. Changing an existing
column's TTL is a `MODIFY COLUMN` operation — run it manually via `conn.raw(...)` if needed.

### Type mapping

| ODAC type              | ClickHouse            |
| ---------------------- | --------------------- |
| `string` / `text` / `nanoid` / `time` | `String` |
| `integer`              | `Int32` (`UInt32` if `unsigned`) |
| `bigInteger`           | `Int64` (`UInt64` if `unsigned`) |
| `float`                | `Float64`             |
| `decimal`              | `Decimal(p, s)`       |
| `boolean`              | `UInt8`               |
| `date`                 | `Date`                |
| `datetime` / `timestamp` | `DateTime`          |
| `uuid`                 | `UUID`                |
| `json` / `jsonb`       | `String`              |
| `enum`                 | `Enum8(...)`          |
| `specificType`         | passed through verbatim |

Use `specificType` as the escape hatch for native ClickHouse types:

```javascript
tags:   { type: 'specificType', length: 'Array(String)' },
country:{ type: 'specificType', length: 'LowCardinality(String)' },
ts_ms:  { type: 'specificType', length: 'DateTime64(3)' }
```

## Writing Data

```javascript
// Direct batch insert
await Odac.DB.analytics.events.insert([{ event: 'login', user_id: 42 }])

// Write-behind buffered insert — coalesced into batches (ideal for high-frequency events)
Odac.DB.analytics.events.buffer.insert({ event: 'pageview', path: '/home' })
await Odac.DB.analytics.events.buffer.flush()   // force flush
```

## Writing Data — single or array

```javascript
await Odac.DB.analytics.events.insert({ event: 'login', user_id: 42 })      // single object
await Odac.DB.analytics.events.insert([{ event: 'a' }, { event: 'b' }])     // array (batch)
```

## Reading Data

A lightweight fluent read builder compiles directly to ClickHouse SQL — no Knex involved.
Identifiers are quoted and values escaped, so it is safe against injection.

```javascript
// Fluent SELECT
const top = await Odac.DB.analytics.events
  .select('path', 'count() AS c')
  .where('created_at', '>=', '2026-01-01')
  .groupBy('path')
  .orderBy('c', 'desc')
  .limit(10)

// Single row
const last = await Odac.DB.analytics.events.where({ user_id: 42 }).orderBy('created_at', 'desc').first()

// Count → plain number
const logins = await Odac.DB.analytics.events.where('event', 'login').count()

// whereIn
const some = await Odac.DB.analytics.events.whereIn('user_id', [1, 2, 3])
```

Available builder methods: `select`, `where` (object / `col, val` / `col, op, val` / `IS NULL`),
`whereIn`, `groupBy`, `orderBy`, `limit`, `offset`, `first`, `count`, `toSQL`. Awaiting the builder
executes it. For anything beyond this surface, drop to raw SQL:

```javascript
// Connection-level raw
const rows = await Odac.DB.analytics.raw(
  'SELECT path, count() AS c FROM events GROUP BY path ORDER BY c DESC LIMIT 10'
)

// Table-scoped raw read
const recent = await Odac.DB.analytics.events.query('SELECT * FROM events ORDER BY created_at DESC LIMIT 100')
```

> **Reads only.** The builder has no `update`/`delete` — ClickHouse has no cheap row-level
> mutations. Model changes as new inserts (with an aggregating engine where appropriate).

## Scope & Limitations

ClickHouse is not a drop-in replacement for a transactional connection. The following are
**intentionally unsupported** on ClickHouse connections, because they are OLTP-only or ClickHouse
anti-patterns:

| Feature | ClickHouse |
| ------- | ---------- |
| Batch `insert` (single/array) + schema `create`/`add column` | ✅ Supported |
| Fluent `select`/`where`/`groupBy`/`orderBy`/`limit`/`first`/`count` | ✅ Supported |
| Raw / analytical reads | ✅ Supported |
| Write-behind `buffer.insert` | ✅ Supported |
| Table- & column-level `ttl` at `CREATE TABLE` | ✅ Supported (MergeTree family) |
| Table-level TTL auto-sync (`MODIFY TTL` / `REMOVE TTL`) | ✅ Diffed vs last-applied expression |
| Column-level TTL change on an existing column | ❌ `MODIFY COLUMN` — run manually |
| Read-through `.cache()` | ❌ OLTP-only |
| Row-level `.where().update()` / `buffer.increment()` | ❌ OLTP-only (no cheap mutations) |
| Foreign keys, unique / secondary indexes | ❌ Not in ClickHouse's model |
| Column drop / type alter in migrations | ❌ Add-column only |
| `migrate:rollback`, `migrate:snapshot` | ❌ Unsupported (append-only / no clean round-trip) |
| Seed **updates** | ❌ Insert-only seeding |

For counters and aggregates on ClickHouse, model them with an aggregating engine
(`SummingMergeTree` / `AggregatingMergeTree`) and `INSERT` deltas — do not reach for row updates.
