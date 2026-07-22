# Getting Started

ODAC supports multiple database connections including **MySQL**, **PostgreSQL** (beta), **SQLite**, and **ClickHouse** (analytics). It uses a robust and secure connection pooling mechanism.

## Configuration

Add your database credentials to `odac.json`.

Supported configuration options:

- `host` - Database server hostname (default: `localhost`)
- `user` - Database username
- `password` - Database password
- `database` - Database name
- `port` - Database port
- `type` - Database type (`mysql`, `postgres`, `sqlite`, `clickhouse`)
- `filename` - Database file path (only for `sqlite`, default: `./dev.sqlite3`)
- `url` - Full endpoint URL (only for `clickhouse`; alternative to host/port)

### Single Connection (MySQL Default)

```json
{
  "database": {
    "type": "mysql",
    "host": "localhost",
    "user": "root",
    "password": "password",
    "database": "odac_app"
  }
}
```

### PostgreSQL

```json
{
  "database": {
    "type": "postgres",
    "host": "localhost",
    "user": "postgres",
    "password": "password",
    "database": "odac_app",
    "port": 5432
  }
}
```

### ClickHouse (Analytics)

ClickHouse is an OLAP (analytics) database. It is best used as a **secondary, append-only connection** for events, logs, and metrics — alongside a MySQL/PostgreSQL primary for transactional data. See [ClickHouse Support](./07-clickhouse.md) for the full scope, schema fields, and limitations.

Requires the `@clickhouse/client` driver: `npm install @clickhouse/client`

```json
{
  "database": {
    "default": {
      "type": "mysql",
      "host": "localhost",
      "database": "main_db"
    },
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

```javascript
// Batch insert events (the write pattern ClickHouse is built for)
await Odac.DB.analytics.events.insert([{ type: 'login', user_id: 42 }])

// Buffered (write-behind) insert — coalesced into batches automatically
Odac.DB.analytics.events.buffer.insert({ type: 'pageview', path: '/home' })

// Read with raw analytical SQL
const top = await Odac.DB.analytics.raw('SELECT path, count() c FROM events GROUP BY path ORDER BY c DESC LIMIT 10')
```

### Multiple Databases

You can configure multiple database connections. The connection named `default` (or the first one) is used automatically.

```json
{
  "database": {
    "default": {
      "type": "mysql",
      "host": "localhost",
      "database": "main_db"
    },
    "analytics": {
      "type": "postgres",
      "host": "analytics.example.com",
      "database": "analytics_db"
    }
  }
}
```

To use a named connection in your code, simply access it through `Odac.DB`:

```javascript
// Primary database (default)
const users = await Odac.DB.users.where('active', true)

// Analytics database
const logs = await Odac.DB.analytics.events.insert({ type: 'login' })
```


---

## Environment Variables

For security, **always** use environment variables for sensitive data.

**.env file:**
```
DB_HOST=localhost
DB_USER=myuser
DB_PASSWORD=mypassword
```

**odac.json:**
```json
{
  "database": {
    "type": "mysql",
    "host": "${DB_HOST}",
    "user": "${DB_USER}",
    "password": "${DB_PASSWORD}"
  }
}
```

---

## Automatic Connection

The connection is established automatically when your application starts. You don't need to write any connection code.

**Next Step:** Check out [Query Basics](./02-basics.md) to start using your database.
