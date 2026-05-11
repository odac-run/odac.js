## 🔌 Database Connection

When you add a `database` object to your `odac.json`, the system will automatically connect to your database. No separate connection setup is needed in your code.

### Basic Configuration

```json
{
  "database": {
    "type": "mysql",
    "host": "localhost",
    "user": "your_user",
    "password": "your_password",
    "database": "your_database"
  }
}
```

Once this is configured, you can directly use `Odac.DB` commands to run queries.

### Using Environment Variables

For better security, especially in production, you can use environment variables for sensitive information:

**odac.json:**
```json
{
  "database": {
    "type": "mysql",
    "host": "${MYSQL_HOST}",
    "user": "${MYSQL_USER}",
    "password": "${MYSQL_PASSWORD}",
    "database": "myapp"
  }
}
```

**.env:**
```bash
MYSQL_HOST=localhost
MYSQL_USER=root
MYSQL_PASSWORD=super_secret_123
```

The `.env` file should be added to `.gitignore` to keep your credentials secure.

### Mixed Approach

You can also mix direct values with environment variables:

```json
{
  "database": {
    "type": "mysql",
    "host": "localhost",
    "user": "root",
    "password": "${MYSQL_PASSWORD}",
    "database": "myapp"
  }
}
```

This way, non-sensitive values are directly in the config while passwords remain in the `.env` file.

### Multiple Database Connections

ODAC supports multiple simultaneous database connections. You can define them as named objects within the `database` configuration:

```json
{
  "database": {
    "default": {
      "type": "mysql",
      "host": "localhost",
      "database": "app_db"
    },
    "analytics": {
      "type": "postgres",
      "host": "remote-stats.db",
      "database": "events"
    }
  }
}
```

#### Usage in Code

To use a specific connection, access it by its name via `Odac.DB`:

```javascript
// Uses 'default' connection
const users = await Odac.DB.users.select('*')

// Uses 'analytics' connection
const events = await Odac.DB.analytics.pageviews.select('*')
```

