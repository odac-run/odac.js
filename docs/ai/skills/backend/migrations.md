---
name: backend-migrations-skill
description: Schema-first ODAC migration strategy for deterministic database evolution, index sync, and cluster-safe execution across SQL engines and ClickHouse (OLAP).
metadata:
  tags: backend, migrations, schema, database-evolution, indexes, cluster-safety, clickhouse, olap
---

# Backend Migrations Skill

Schema-first, zero-config migration strategy for ODAC.

## Architectural Approach
ODAC migrations are **declarative**. The `schema/` directory is the single source of truth for final DB state. The migration engine diffs desired schema vs current DB and applies create/alter/drop operations automatically.

## Core Rules
1. **Source of Truth**: Always update `schema/*.js` files, not historical migration chains, for structural changes.
2. **Auto Execution**: Migrations run automatically during app startup via `Database.init()`.
3. **Cluster Safety**: Auto-migration runs only on `cluster.isPrimary` to prevent race conditions.
4. **Index Sync**: Define indexes in schema; engine adds/removes them automatically.
5. **Drop Behavior**: If a column/index is removed from schema, it is removed from DB on next startup.
6. **Seeds**: Use `seed` + `seedKey` for idempotent reference data.
7. **NanoID Columns**: `type: 'nanoid'` maps to string columns and missing values are auto-generated on insert/seed.
8. **Data Transformations**: Use imperative files under `migration/` only for one-time data migration logic.

## Reference Patterns
### 1. Schema File (Final State)
```javascript
// schema/users.js
'use strict'

module.exports = {
  columns: {
    id: {type: 'nanoid', primary: true},
    email: {type: 'string', length: 255, nullable: false},
    role: {type: 'enum', values: ['admin', 'user'], default: 'user'},
    timestamps: {type: 'timestamps'}
  },
  indexes: [
    {columns: ['email'], unique: true}
  ],
  seed: [
    {email: 'admin@example.com', role: 'admin'}
  ],
  seedKey: 'email'
}
```

### 2. Foreign Keys & Referential Actions
```javascript
// schema/posts.js
module.exports = {
  columns: {
    id:      {type: 'nanoid', primary: true},
    user_id: {
      type:       'integer',
      unsigned:   true,
      nullable:   false,
      references: {table: 'users', column: 'id'},
      onDelete:   'CASCADE',  // 'CASCADE' | 'SET NULL' | 'RESTRICT' | 'NO ACTION' | 'SET DEFAULT'
      onUpdate:   'CASCADE'
    }
  }
}
```

**Rules:**
- `references` + `onDelete`/`onUpdate` are supported in table creation, column addition, and schema-diff updates to existing columns.
- Schema diff supports adding, dropping, and replacing an existing column's foreign key constraint. Use an imperative `migration/` file only for cases that require custom data movement or engine-specific manual SQL.
- Always index foreign key columns for query performance.

### NanoID Notes
- `length` can be customized: `{type: 'nanoid', length: 12, primary: true}`.
- If seed rows omit the nanoid field, ODAC fills it automatically.
- If seed rows provide an explicit nanoid value, ODAC keeps it unchanged.

### 2. Multi-Database Layout
```
schema/
  users.js            # default DB
  analytics/
    events.js         # analytics DB
```

### ClickHouse Schema (OLAP)
ClickHouse tables live under a named-connection subdirectory (e.g. `schema/analytics/events.js`)
and use the same `columns` format plus ClickHouse-only fields (ignored by SQL engines). CREATE TABLE
needs a table **engine** and a **sorting key**.
```javascript
// schema/analytics/events.js
module.exports = {
  engine: 'MergeTree',                    // default 'MergeTree'; 'ReplacingMergeTree(ver)' etc. passed verbatim
  orderBy: ['created_at', 'id'],          // sorting key (MergeTree requires one; defaults to tuple())
  partitionBy: 'toYYYYMM(created_at)',    // optional
  ttl: 'created_at + INTERVAL 30 DAY',    // optional table-level retention (raw TTL expr, MergeTree only)
  settings: 'index_granularity = 8192',   // optional raw SETTINGS
  columns: {
    id:         {type: 'nanoid'},
    user_id:    {type: 'bigInteger'},
    event:      {type: 'string'},
    source:     {type: 'string', nullable: true},   // nullable ONLY when explicitly true (see below)
    token:      {type: 'string', default: '', ttl: 'created_at + INTERVAL 7 DAY'},  // per-column TTL: expires value, not row
    created_at: {type: 'datetime', nullable: false}
  },
  seedKey: 'event',                       // insert-only seeding on ClickHouse
  seed: [{event: 'signup', user_id: 0, id: '', created_at: '2026-01-01 00:00:00'}]
}
```

**ClickHouse migration rules:**
- **Nullable inverted**: SQL treats unspecified `nullable` as NULLABLE; ClickHouse columns are NOT NULL by default. A CH column is nullable **only** when `nullable: true`.
- **Add-column only**: schema diff creates tables and adds new columns. Column drops, type alters, indexes and foreign keys are **not** applied on ClickHouse.
- **TTL** (`ttl` field, table- or column-level): raw CH expression, MergeTree-family only. **Table-level TTL is auto-synced**: changing/removing `ttl` in the schema issues `MODIFY TTL` / `REMOVE TTL` on the next migrate. The diff compares against the **last-applied** expression (tracked in `_odac_migrations`, type='ttl' rows) — not live DDL, because CH normalizes expressions (`INTERVAL 30 DAY` → `toIntervalDay(30)`). Manual out-of-band TTL edits are invisible to the diff; keep the schema expression byte-stable to avoid needless re-applies (`MODIFY TTL` materializes on existing parts = heavy on big tables). Column-level TTL applies at CREATE/ADD COLUMN only; changing it later is a manual `MODIFY COLUMN`.
- **`rollup` DSL (automatic downsampling)**: a declarative shorthand that **compiles to `orderBy` + a multi-tier `ttl`** (`TTL … GROUP BY … SET …`) for time-series tables. Use it instead of hand-writing `orderBy`/`ttl` when you want old data rolled into coarser buckets during background merges. It flows through the same auto-sync `MODIFY TTL` diff.
  ```javascript
  rollup: {
    time: 't',                 // timestamp column each tier ages against (must be a declared column)
    by: ['resource_id'],       // non-time leading dims; kept in every tier's GROUP BY
    count: 'samples',          // sample-count column, default 'samples' (alias: samplesColumn)
    tiers: [
      {olderThan: '24 HOUR', bucket: 'tenMinutes'},  // >24h → 10-min buckets
      {olderThan: '30 DAY',  bucket: 'day'},         // >30d → daily buckets
      {bucket: 'week', reserve: true},               // spare bucket: ORDER BY only, no TTL step
      {olderThan: '2 YEAR',  delete: true}           // optional final purge tier
    ],
    set: {cpu: 'sum', net_rx_total: 'max', pids: 'max'}  // per-column aggregate
  }
  ```
  Rules the compiler enforces (throws on violation — never silent):
  - **`orderBy` is derived** = `[...by, buckets coarse→fine]` so each tier's GROUP BY is a primary-key prefix. A hand-written `orderBy` is honored **only if it starts with** that derived prefix.
  - **No `avg`.** Averaging averages drifts across tiers → ODAC injects a `samples UInt64 DEFAULT 1` column, sums it every tier, and rejects `avg`. Compute mean at read time as `sum(x) / sum(samples)`. Allowed aggregates: `sum`, `max`, `min`, `any`.
  - **Buckets must coarsen as data ages**; vocabulary: `minute`, `fiveMinutes`, `tenMinutes`, `fifteenMinutes`, `hour`, `day`, `week`, `month`, `quarter`, `year`.
  - **`delete: true`** tier (if any) must be the oldest. Columns absent from `by`/`set` take an arbitrary in-bucket value (CH `any()`), so add them to `by` or `set: {col: 'any'}` if that matters.
  - **`reserve: true`** tier (bucket, **no `olderThan`**) pre-registers a granularity in `ORDER BY` without emitting a TTL step. Since `ORDER BY` is fixed at CREATE, this lets you **activate that bucket later** (swap `reserve: true` → `olderThan`) as a pure `MODIFY TTL` with **no table recreate**. Changing/adding a bucket granularity that is NOT reserved reshapes `ORDER BY` → requires recreate. Compiler rejects a reserve with `olderThan`, a tier missing `olderThan` that isn't reserve/delete, and reserving a bucket an active tier already uses.
  - **Requires a MergeTree-family engine**; `rollup` replaces manual `ttl` for the table (use one, not both).
- **`specificType` passthrough**: use it for native CH types — `{type: 'specificType', length: 'LowCardinality(String)'}`, `'Array(UInt32)'`, `'DateTime64(3)'`.
- **Seeds are insert-only** (no mutation-based updates); existing rows (matched by `seedKey`) are left untouched.
- **`migrate:rollback` and `migrate:snapshot` are unsupported** on ClickHouse connections (append-only / no clean type round-trip).
- `npx odac migrate` / `migrate:status` work normally; use `--db=analytics` to target one connection.

### 3. Imperative Data Migration (One-Time)
```javascript
// migration/20260225_001_backfill_roles.js
module.exports = {
  async up(db) {
    await db('users').whereNull('role').update({role: 'user'})
  },
  async down(db) {
    await db('users').where('role', 'user').update({role: null})
  }
}
```

### 4. CLI Operations
```bash
npx odac migrate
npx odac migrate:status
npx odac migrate:rollback
npx odac migrate:snapshot
```

## Performance and Safety Notes
- Keep schema declarations deterministic and minimal.
- Prefer additive changes; drops are destructive and should be intentional.
- Ensure high-cardinality lookup columns are indexed in schema definitions.
- For very large tables, plan expensive column rewrites as dedicated data migrations.
