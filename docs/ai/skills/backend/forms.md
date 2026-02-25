# Backend Forms & Validation Skill

Processing form data securely and validating inputs.

## Rules
1.  **Validator**: Always use `Odac.Validator` for input.
2.  **Auto-save**: Use `Odac.Db.table().save(Odac.Request.post())` for quick inserts.
3.  **CSRF**: Ensure `{{ TOKEN }}` is in your HTML forms.

## Patterns
```javascript
// Validation
const check = Odac.Validator.run(Odac.Request.post(), {
  email: 'required|email',
  password: 'required|min:8'
});

if (check.failed()) return Odac.Request.error(check.errors());
```
