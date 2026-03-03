# Schema-First Migrations

ODAC uses a **declarative, schema-first** approach to database migrations. Instead of writing sequential migration files, you define the **desired final state** of each table in a schema file. The engine automatically diffs the schema against your database and applies the necessary changes.

> **AI Agent Friendly:** A single schema file per table = instant understanding of the final database state. No need to scan hundreds of migration files.

---

## Quick Start

### 1. Define Your Schema

Create a file in the `schema/` directory for each table:

```javascript
// schema/users.js
'use strict'

module.exports = {
  columns: {
    id:         {type: 'increments'},
    name:       {type: 'string', length: 255, nullable: false},
    email:      {type: 'string', length: 255, nullable: false},
    role:       {type: 'enum', values: ['admin', 'user'], default: 'user'},
    is_active:  {type: 'boolean', default: true},
    timestamps: {type: 'timestamps'}
  },

  indexes: [
    {columns: ['email'], unique: true},
    {columns: ['role', 'is_active']}
  ]
}
```

### 2. Start Your App

Migrations run **automatically** when the application starts. No manual commands needed:

```bash
npx odac dev    # Development
npx odac start  # Production
```

On startup, the engine detects `schema/users.js`, creates the table, and applies indexes — all before the server accepts traffic.

> **Zero-Config:** Just define the schema file and deploy. The framework handles the rest.

You can also run migrations manually via CLI for inspection or rollback:

### 3. Modify Your Schema

Simply edit the schema file. Add a column, remove a column, add an index — the engine handles the rest:

```javascript
// schema/users.js — added 'bio' column, removed 'is_active'
module.exports = {
  columns: {
    id:         {type: 'increments'},
    name:       {type: 'string', length: 255, nullable: false},
    email:      {type: 'string', length: 255, nullable: false},
    role:       {type: 'enum', values: ['admin', 'user'], default: 'user'},
    bio:        {type: 'text', nullable: true},
    timestamps: {type: 'timestamps'}
  },

  indexes: [
    {columns: ['email'], unique: true}
  ]
}
```

```bash
npx odac migrate
```

```
  [default]
    + ADD COLUMN users.bio
    - DROP COLUMN users.is_active
    - DROP INDEX users (role, is_active)

✅ 3 operation(s) completed.
```

---

## Column Types

| Type | Usage | Options |
|------|-------|---------|
| `increments` | Auto-increment primary key | — |
| `bigIncrements` | Big auto-increment | — |
| `nanoid` | NanoID string key (auto-generated on insert) | `length` (default: 21) |
| `integer` | Integer | `unsigned` |
| `bigInteger` | Big integer | `unsigned` |
| `float` | Floating point | `precision`, `scale` |
| `decimal` | Exact decimal | `precision`, `scale` |
| `string` | Varchar | `length` (default: 255) |
| `text` | Text blob | `textType` ('text', 'mediumtext', 'longtext') |
| `boolean` | Boolean | — |
| `date` | Date only | — |
| `datetime` | Date and time | — |
| `timestamp` | Timestamp | — |
| `timestamps` | Virtual: creates `created_at` + `updated_at` | — |
| `time` | Time only | — |
| `binary` | Binary data | `length` |
| `json` | JSON | — |
| `jsonb` | Binary JSON (PostgreSQL) | — |
| `uuid` | UUID | — |
| `enum` | Enumeration | `values` (array) |

## Column Modifiers

```javascript
{
  type: 'string',
  length: 100,
  nullable: false,        // NOT NULL constraint
  default: 'untitled',    // Default value
  unsigned: true,         // Unsigned integer
  unique: true,           // Unique constraint (inline)
  primary: true,          // Primary key
  comment: 'The title',   // Column comment
  references: {           // Foreign key
    table: 'categories',
    column: 'id'
  },
  onDelete: 'CASCADE',
  onUpdate: 'CASCADE'
}
```

---

## Seed Data

Schema files can include declarative seed data that is applied idempotently on every migration:

```javascript
// schema/roles.js
module.exports = {
  columns: {
    id:    {type: 'increments'},
    name:  {type: 'string', length: 50},
    level: {type: 'integer', default: 0}
  },

  indexes: [],

  seed: [
    {name: 'admin', level: 100},
    {name: 'editor', level: 50},
    {name: 'user', level: 1}
  ],
  seedKey: 'name'
}
```

- **`seed`** — Array of rows to ensure exist
- **`seedKey`** — Column used for uniqueness check (required when `seed` is present)

**Behavior:** If the row exists (matched by `seedKey`), it updates if values differ. If not, it inserts. Safe to run repeatedly.

---

## Data Migrations

For **one-time data transformations** (splitting columns, backfilling, etc.), use imperative migration files:

```
migration/
  20260225_001_split_names.js
```

```javascript
// migration/20260225_001_split_names.js
module.exports = {
  async up(db) {
    const users = await db('users').select('id', 'full_name')
    for (const user of users) {
      const [first, ...rest] = user.full_name.split(' ')
      await db('users').where('id', user.id).update({
        first_name: first,
        last_name: rest.join(' ')
      })
    }
  },

  async down(db) {
    const users = await db('users').select('id', 'first_name', 'last_name')
    for (const user of users) {
      await db('users').where('id', user.id).update({
        full_name: `${user.first_name} ${user.last_name}`
      })
    }
  }
}
```

Migration files run **once** and are tracked in the `_odac_migrations` table.

---

## Multiple Databases

If your project has multiple database connections, organize schemas by connection:

```
schema/
  users.js              ← default connection
  posts.js              ← default connection
  analytics/            ← 'analytics' connection
    events.js
    pageviews.js
```

The folder name matches the connection key in your `odac.json`:

```json
{
  "database": {
    "default": {"type": "mysql", "database": "main_db"},
    "analytics": {"type": "postgres", "database": "analytics_db"}
  }
}
```

Migration files follow the same convention:

```
migration/
  20260225_001_auto.js          ← default connection
  analytics/
    20260225_001_backfill.js    ← analytics connection
```

---

## CLI Commands

```bash
# Run all pending migrations (schema diff + files + seeds)
npx odac migrate

# Target a specific database connection
npx odac migrate --db=analytics

# Show pending changes without applying (dry-run)
npx odac migrate:status

# Rollback the last batch of migration files
npx odac migrate:rollback

# Reverse-engineer current database into schema/ files
npx odac migrate:snapshot
npx odac migrate:snapshot --db=analytics
```

---

## Snapshot — Importing Existing Databases

For existing projects, use `migrate:snapshot` to generate schema files from your current database:

```bash
npx odac migrate:snapshot
```

This creates a schema file for each table. Review and adjust the generated files, then use them as your source of truth going forward.
