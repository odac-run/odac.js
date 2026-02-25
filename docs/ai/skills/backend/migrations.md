````markdown
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
7. **Data Transformations**: Use imperative files under `migration/` only for one-time data migration logic.

## Reference Patterns
### 1. Schema File (Final State)
```javascript
// schema/users.js
'use strict'

module.exports = {
  columns: {
    id: {type: 'increments'},
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

### 2. Multi-Database Layout
```
schema/
  users.js            # default DB
  analytics/
    events.js         # analytics DB
```

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

````