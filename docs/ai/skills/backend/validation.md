---
name: backend-validation-skill
description: Fluent ODAC validation strategies for input hardening, brute-force protection, and standardized error responses.
metadata:
  tags: backend, validation, fluent-api, input-security, brute-force, error-handling
---

# Backend Validation Skill

The `Validator` service provides a fluent, chainable API for securing user input and enforcing business rules.

## Architectural Approach
Validation should happen as early as possible in the request lifecycle. The `Validator` service handles automatic error formatting and frontend integration.

## Core Rules
1.  **Chaining**: Use the fluent API: `.post(key).check(rules).message(msg)`.
2.  **Brute Force**: Protect sensitive endpoints with `.brute(attempts)`.
3.  **Automatic Errors**: Use `await validator.error()` to check status and `await validator.result()` to return standardized JSON.
4.  **Inverse Rules**: Use `!` to invert any rule (e.g., `!required`).

## Reference Patterns

### 1. Standard Validation Chaining
```javascript
module.exports = async function (Odac) {
  const validator = Odac.Validator;

  validator
    .post('email').check('required|email').message('Valid email required')
    .post('password').check('required|minlen:8').message('Password too short');

  if (await validator.error()) {
    return validator.result('Please fix input errors');
  }

  // Proceed with validated data
  return validator.success('Success');
};
```

### 2. Custom Variable and Security Validation
```javascript
validator.var('age', userAge).check('numeric|min:18').message('Must be 18+');

// Security checks
validator.post('bio').check('xss').message('Malicious HTML detected');
validator.var('auth', null).check('usercheck').message('Authentication required');
```

### 3. Common Rules Reference
-   `required`, `email`, `numeric`, `username`, `url`, `ip`, `json`.
-   `len:X`, `minlen:X`, `maxlen:X`.
-   `mindate:YYYY-MM-DD`, `maxdate:YYYY-MM-DD`.
-   `regex:pattern`, `same:field`, `different:field`.
-   `!disposable`: Blocks temporary email providers.

## Best Practices
-   **Specific Messages**: Provide helpful error messages that guide the user.
-   **Security First**: Use the `xss` rule for any user-generated content that will be rendered later.
-   **Fail Fast**: Return the validation result immediately if `validator.error()` is true.
