---
name: backend-validation-skill
description: Detailed ODAC Validator usage for request validation, security checks, brute-force protection, and consistent API responses.
metadata:
  tags: backend, validation, fluent-api, input-security, brute-force, error-handling
---

# Backend Validation Skill

ODAC validation should be centralized with the fluent `Validator` API and returned in framework-standard result format.

## Core Rules
1.  **Create validator per request**: Use `const validator = Odac.validator()`.
2.  **Fail fast**: Run all checks, then immediately return on `await validator.error()`.
3.  **Field-first messages**: Assign a specific `.message(...)` per check chain.
4.  **Use standard result shape**: Return `await validator.result('Validation failed')` for errors.
5.  **Protect sensitive flows**: Add `await validator.brute(n)` on login/reset/auth endpoints.

## Minimal Flow
```javascript
module.exports = async Odac => {
  const validator = Odac.validator()

  validator.post('email').check('required|email').message('Valid email required')
  validator.post('password').check('required|minlen:8').message('Password must be at least 8 characters')

  if (await validator.error()) {
    await validator.brute(5)
    return await validator.result('Validation failed')
  }

  return await validator.success({ok: true})
}
```

## API Surface
- `post(key)`: Validate POST payload field.
- `get(key)`: Validate querystring field.
- `var(name, value)`: Validate computed/custom value.
- `file(name)`: Validate uploaded file object.
- `check(rules | boolean)`: Apply pipe rules or direct boolean validation.
- `message(text)`: Set message for the latest check on current field.
- `error()`: Runs validation and returns `true` if any error exists.
- `result(message?, data?)`: Returns ODAC-standard response object.
- `success(dataOrMessage?)`: Convenience wrapper for success payload.
- `brute(maxAttempts = 5)`: Tracks failed attempts per hour/page/ip.

## Rule Catalog

### Type & format rules
- `required`, `accepted`
- `numeric`, `float`
- `alpha`, `alphaspace`, `alphanumeric`, `alphanumericspace`, `username`
- `email`, `ip`, `mac`, `domain`, `url`
- `array`, `date`, `xss`

### Length & value rules
- `len:X`, `minlen:X`, `maxlen:X`
- `min:X`, `max:X`
- `equal:value`, `not:value`
- `same:field`, `different:field`

### String/date matching rules
- `in:substring`, `notin:substring`
- `regex:pattern`
- `mindate:YYYY-MM-DD`, `maxdate:YYYY-MM-DD`

### Auth/security rules
- `usercheck`: Must be authenticated.
- `user:field`: Input must match authenticated user field.
- `disposable`: Email must be disposable.
- `!disposable`: Email must not be disposable.

### Inverse rules
- Prefix any rule with `!` to invert: `!required`, `!email`, `!equal:admin`.

## Reference Patterns

### 1) Multi-check per field with specific errors
```javascript
module.exports = async Odac => {
  const validator = Odac.validator()

  validator
    .post('password')
    .check('required').message('Password is required')
    .check('minlen:8').message('Minimum 8 characters')
    .check('regex:[A-Z]').message('At least one uppercase letter')
    .check('regex:[0-9]').message('At least one number')

  if (await validator.error()) {
    return await validator.result('Please fix input errors')
  }

  return await validator.success('Success')
}
```

### 2) GET + POST + VAR together
```javascript
module.exports = async Odac => {
  const validator = Odac.validator()
  const plan = await Odac.request('plan')

  validator.get('page').check('numeric|min:1').message('Invalid page')
  validator.post('email').check('required|email|!disposable').message('Corporate email required')
  validator.var('plan', plan).check('in:pro').message('Only pro plan is allowed')

  if (await validator.error()) return await validator.result('Validation failed')
  return await validator.success({ok: true})
}
```

### 3) Boolean check for business rules
```javascript
module.exports = async Odac => {
  const validator = Odac.validator()
  const canPublish = await somePermissionCheck(Odac)

  validator.post('title').check('required').message('Title required')
  validator.var('permission', null).check(canPublish).message('No publish permission')

  if (await validator.error()) return await validator.result('Validation failed')
  return await validator.success('Published')
}
```

### 4) Brute-force on auth endpoint
```javascript
module.exports = async Odac => {
  const validator = Odac.validator()

  validator.post('email').check('required|email').message('Email required')
  validator.post('password').check('required').message('Password required')

  if (await validator.error()) {
    await validator.brute(5)
    return await validator.result('Login failed')
  }

  return await validator.success('OK')
}
```

## Response Contract
- **Success**:
  - `result.success: true`
  - optional `result.message`
  - optional `data`
- **Failure**:
  - `result.success: false`
  - `errors.{field}` map
  - global errors may use `errors._odac_form`

## Best Practices
- Keep validation at route/controller entry; do not defer to deep service layers.
- Use separate `check()` calls when you need rule-specific messages.
- Prefer `var()` for derived values instead of re-reading mutable request state.
- Use `xss` for text fields that can later be rendered in HTML.
- Always combine auth endpoints with `brute()` to reduce credential-stuffing risk.
