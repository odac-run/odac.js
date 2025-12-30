# Query Basics

ODAC features a powerful, efficient, and "magic" Query Builder. It allows you to interact with your database using simple, chainable methods without writing raw SQL.

## Accessing Tables

You can access any table directly as a property of `Odac.DB`.

```javascript
// Access the 'users' table
const query = Odac.DB.users;
```

If you have multiple database connections defined in your config:

```javascript
// Access 'visits' table on 'analytics' connection
const visits = Odac.DB.analytics.visits;
```

---

## Retrieving Data (Select)

### Fetch All Rows

```javascript
const users = await Odac.DB.users.select();
```

### Fetch a Single Row

Use `.first()` to get a single object instead of an array.

```javascript
const user = await Odac.DB.users.where('id', 1).first();
```

### Filtering (Where)

```javascript
// Simple equals
const users = await Odac.DB.users.where('email', 'john@example.com').select();

// Comparison operators
const products = await Odac.DB.products.where('price', '>', 100).select();
const activeUsers = await Odac.DB.users.where('status', '!=', 'banned').select();

// OR statements
const staff = await Odac.DB.users
  .where('role', 'admin')
  .orWhere('role', 'editor')
  .select();
```

### Ordering and Limiting

```javascript
const latestPosts = await Odac.DB.posts
  .orderBy('created_at', 'desc')
  .limit(5);
```

### Counting Rows

ODAC simplifies counting rows. Unlike standard Knex behavior which might return objects or strings, `count()` directly returns a `Number` for simple queries.

```javascript
const totalUsers = await Odac.DB.users.count(); // Returns: 150 (Number)

const activeAdmins = await Odac.DB.users
    .where('role', 'admin')
    .where('active', true)
    .count(); // Returns: 5 (Number)
```

---

## Inserting Data

```javascript
// Insert a single record
await Odac.DB.users.insert({
  name: 'John Doe',
  email: 'john@example.com'
});

// Insert multiple records
await Odac.DB.tags.insert([
  { name: 'javascript' },
  { name: 'nodejs' }
]);
```

---

## Updating Data

```javascript
await Odac.DB.users
  .where('id', 1)
  .update({
    status: 'active',
    last_login: new Date()
  });
```

---

## Deleting Data

await Odac.DB.users.where('id', 1).delete();
```

---

## ID Generation (NanoID)

ODAC includes a built-in helper for generating robust, unique string IDs (NanoID) without needing external packages. Secure, URL-friendly, and collision-resistant.

```javascript
// Generate a standard 21-character ID (e.g., "V1StGXR8_Z5jdHi6B-myT")
const id = Odac.DB.nanoid();

// Generate a custom length ID
const shortId = Odac.DB.nanoid(10);
```

This is particularly useful when inserting records into tables that use string-based Primary Keys instead of auto-increment integers.

```javascript
await Odac.DB.posts.insert({
    id: Odac.DB.nanoid(),
    title: 'My First Post'
});
```
