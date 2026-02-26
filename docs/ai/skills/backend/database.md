---
name: backend-database-skill
description: High-performance ODAC database querying patterns using the built-in query builder with secure and efficient data access.
metadata:
  tags: backend, database, query-builder, sql, indexing, performance, security
---

# Backend Database Skill

High-performance database operations using the ODAC Query Builder.

## Principles
1.  **Directness**: Avoid ORM overhead. Use fluent Query Builder.
2.  **Safety**: Always use parameterized queries (built-in).
3.  **Efficiency**: Index foreign keys. No `SELECT *`.

## Patterns
```javascript
const user = await Odac.DB.table('users')
  .select('id', 'name', 'email')
  .where('status', 'active')
  .first();

await Odac.DB.table('posts').insert({
  title: 'Hello',
  user_id: 1
});
```

## Migration Awareness
1.  **Schema-First**: Structural DB changes must be defined in `schema/*.js`.
2.  **Auto-Migrate**: Migrations run automatically at startup from `Database.init()`.
3.  **Cluster-Safe**: Migration execution is limited to primary process (`cluster.isPrimary`).
4.  **Indexes**: Keep index definitions in schema so add/drop is managed automatically.
5.  **Data Changes**: Use `migration/*.js` only for one-time data transformation.

See: [migrations.md](./migrations.md)
