# Frontend Navigation & SPA Skill

Smooth transitions and single-page application behavior using `odac.js`.

## Rules
1.  **Selection**: Enable via `Odac.action({ navigate: 'main' })`.
2.  **Exclusion**: Use `data-navigate="false"` or `.no-navigate` class for full reloads.
3.  **Lifecycle**: Use `load` and `page` events to run code after navigation.

## Patterns
```javascript
Odac.action({
  navigate: {
    update: 'main',
    on: function(page, vars) {
      console.log('Navigated to:', page);
    }
  }
});
```
