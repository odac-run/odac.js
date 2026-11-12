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
- `url` - Connection URL, alternative to host/user/password/database (`postgres://...`, `mysql://...`, or the ClickHouse HTTP endpoint). `connectionString` is accepted as an alias for MySQL/PostgreSQL
- `ssl` - TLS for MySQL/PostgreSQL: `true` for TLS with the system CAs, or the driver's TLS object (`{"ca": "...", "rejectUnauthorized": true}`)
- `charset` - Connection character set (MySQL, e.g. `utf8mb4`)
- `timezone` - Session time zone (MySQL: `"Z"`, `"+03:00"`, `"local"`; PostgreSQL: a zone name such as `"UTC"` or `"Europe/Istanbul"`)
- `options` - Any other driver option, passed to `mysql2` / `pg` as given
- `connectionLimit` - Maximum pool size per process. When omitted, ODAC sizes the pools so the whole cluster stays near 80 connections (2 to 10 per process; see [Automatic Connection](#automatic-connection))

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

### Managed Databases (TLS, Connection URL)

```json
{
  "database": {
    "type": "postgres",
    "url": "${DATABASE_URL}",
    "ssl": {"rejectUnauthorized": true}
  }
}
```

### SQLite

```json
{
  "database": {
    "type": "sqlite",
    "filename": "./storage/app.sqlite3"
  }
}
```

Requires the `sqlite3` driver: `npm install sqlite3`. Each type needs its own driver package (`mysql2`, `pg`, `sqlite3`, `@clickhouse/client`); ODAC does not install them.

`sqlite3` is a native addon whose binary is fetched by an install script. npm 12 and later skip dependency install scripts unless the project's `package.json` allows them. Projects created with `odac init` already allow it:

```json
"allowScripts": {
  "sqlite3": true
}
```

Without that entry the package lands in `node_modules` without its binary, and ODAC fails at startup with `Database driver "sqlite3" is installed but failed to load`. In an existing project, allow the script once and rebuild:

```bash
npm install-scripts approve sqlite3
npm rebuild sqlite3
```

`approve` writes a version-pinned entry such as `"sqlite3@6.0.1": true`, which has to be approved again after every `sqlite3` upgrade. A name-only entry (`"sqlite3": true`, as in `odac init` projects, or `npm install-scripts approve sqlite3 --no-allow-scripts-pin`) allows any version.

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

ODAC tests each connection at startup. If a database is unreachable when the app boots, startup fails with an error instead of serving requests against a dead connection. A worker that is restarted later only logs the failure, since queries reconnect on their own once the database is back.

Each process (the primary plus one worker per CPU core) opens its own connection pool. Without `connectionLimit`, ODAC divides a budget of about 80 connections among them, between 2 and 10 per process, which fits PostgreSQL's default `max_connections` of 100. If you set `connectionLimit`, every process uses that value, so the cluster opens up to `connectionLimit × (cores + 1)` connections.

**Next Step:** Check out [Query Basics](./02-basics.md) to start using your database.
