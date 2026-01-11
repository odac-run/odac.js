# Code-First Migrations

Migration files are great, but sometimes (especially in rapid development or zero-config apps) you want dependencies to define their own table structures automatically.

ODAC uses the `.schema()` helper for this logic.

## Ensuring Tables Exist

The `.schema()` method checks if a table exists. If it **does not exist**, it runs the provided callback to create it. If it **already exists**, it does nothing.

```javascript
// Ensure 'products' table exists on the fly
await Odac.DB.products.schema(t => {
   t.increments('id');
   t.string('name').notNullable();
   t.decimal('price', 10, 2);
   t.boolean('is_active').defaultTo(true);
   
   // Automatic timestamps (created_at, updated_at)
   t.timestamps(true, true);
});
```

The `t` argument is a Schema Builder. You can define columns using standard types like:
- `t.string()`
- `t.integer()`
- `t.boolean()`
- `t.text()`
- `t.date()`
- `t.json()`

## Usage Example

A typical pattern is to define schemas in your module's initialization or before the first insert.

```javascript
// In your controller or module
async function init() {
    await Odac.DB.logs.schema(t => {
        t.string('level');
        t.text('message');
        t.timestamps();
    });
}

// Later...
await Odac.DB.logs.insert({ level: 'info', message: 'App started' });
```
