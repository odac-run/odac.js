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
