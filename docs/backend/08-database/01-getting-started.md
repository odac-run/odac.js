# Getting Started

ODAC supports multiple database connections including **MySQL**, **PostgreSQL** (beta), and **SQLite**. It uses a robust and secure connection pooling mechanism.

## Configuration

Add your database credentials to `odac.json`.

Supported configuration options:

- `host` - Database server hostname (default: `localhost`)
- `user` - Database username
- `password` - Database password
- `database` - Database name
- `port` - Database port
- `type` - Database type (`mysql`, `postgres`, `sqlite`)
- `filename` - Database file path (only for `sqlite`, default: `./dev.sqlite3`)

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
