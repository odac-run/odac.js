# Frontend Forms & API Skill

Handling AJAX form submissions and API requests.

## Rules
1.  **Forms**: Use `odac.form('#id', callback)` for AJAX submission.
2.  **Requests**: Use `odac.get()` and `odac.post()` for manual requests.
3.  **Realtime**: Handle WebSocket events using Hub structures in `Odac.action()`.

## Patterns
```javascript
// Form with automatic validation feedback
odac.form('#my-form', (res) => {
  if(res.success) odac.visit('/done');
});

// Simple API Check
odac.get('/api/status', (data) => {
  console.log('Status:', data);
});
```
