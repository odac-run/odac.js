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
await Odac.DB.users.where('email', 'john@example.com');

// Comparison operators
await Odac.DB.products.where('price', '>', 100);
await Odac.DB.users.where('status', '!=', 'banned');

// OR statements
await Odac.DB.users
  .where('role', 'admin')
  .orWhere('role', 'editor');
```

### Ordering and Limiting

```javascript
const latestPosts = await Odac.DB.posts
  .orderBy('created_at', 'desc')
  .limit(5);
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

```javascript
await Odac.DB.users.where('id', 1).delete();
```
