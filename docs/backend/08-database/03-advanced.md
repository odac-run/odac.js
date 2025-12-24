# Advanced Queries

For complex applications, ODAC provides advanced query capabilities like nested constraints, joins, transactions, and raw SQL execution.

## Nested Where Clauses

To create complex `AND / OR` logic (like parenthesis in SQL), use a callback function with `.where()` or `.andWhere()`.

**Example:**
`SELECT * FROM users WHERE status = 'active' AND (role = 'admin' OR role = 'editor')`

**ODAC Code:**
```javascript
await Odac.DB.users
  .where('status', 'active')
  .andWhere(builder => {
    builder.where('role', 'admin').orWhere('role', 'editor');
  })
  .select();
```

---

## Joins

You can join multiple tables using `.join()`, `.leftJoin()`, etc.

```javascript
const posts = await Odac.DB.posts
  .join('users', 'posts.user_id', '=', 'users.id')
  .select('posts.title', 'users.name as author');
```

---

## Transactions

Transactions allow you to ensure multiple database operations succeed or fail together.

```javascript
await Odac.DB.transaction(async (trx) => {
  
  const [userId] = await trx('users').insert({ name: 'Alice' });
  
  await trx('accounts').insert({ user_id: userId, balance: 100 });

  // If anything throws an error here, both inserts are rolled back.
});
```

> **Note:** Use `Odac.DB.connectionName.transaction(...)` for non-default connections.

---

## Raw Queries & Values

### Raw SQL Execution
If you need to execute a completely raw SQL query:

```javascript
const result = await Odac.DB.run('SELECT email FROM users WHERE id = ?', [1]);
```

### Raw Values in Updates
Sometimes you need to call SQL functions (like `NOW()` or `COUNT()`) inside an update or insert.

```javascript
await Odac.DB.users.where('id', 1).update({
  updated_at: Odac.DB.raw('NOW()'),
  visits: Odac.DB.raw('visits + 1')
});
```

---

## Safe Table Access

If your table name conflicts with a reserved ODAC method (e.g., `transaction`, `schema`, `run`), use the `.table()` method to access it safely.

```javascript
// Access a table named 'transaction'
const logs = await Odac.DB.table('transaction').select();
```

