# Backend Database Skill

High-performance database operations using the ODAC Query Builder.

## Principles
1.  **Directness**: Avoid ORM overhead. Use fluent Query Builder.
2.  **Safety**: Always use parameterized queries (built-in).
3.  **Efficiency**: Index foreign keys. No `SELECT *`.

## Patterns
```javascript
const user = await Odac.Db.table('users')
  .select('id', 'name', 'email')
  .where('status', 'active')
  .first();

await Odac.Db.table('posts').insert({
  title: 'Hello',
  user_id: 1
});
```
