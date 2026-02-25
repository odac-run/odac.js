---
name: backend-utilities-skill
description: Practical ODAC utility patterns for string processing, hashing, encryption, and request flow control.
metadata:
    tags: backend, utilities, strings, hashing, encryption, flow-control
---

# Backend Utilities Skill

String manipulation, hashing, and flow control.

## Core Rules
1.  **Odac.Var**: A fluent interface for strings. Use it for `.slug()`, `.hash()`, `.is('email')`, and `.encrypt()`.
2.  **Flow Control**:
    -   `Odac.abort(code)`: Terminate request with HTTP status (e.g., 404, 403).
    -   `Odac.direct(url)`: Redirect the user.
    -   `Odac.session(key, value)`: Manage session data.

## Reference Patterns
### 1. Odac.Var (String Power)
```javascript
const slug = Odac.Var('My Post Title').slug();
const isValid = Odac.Var('test@test.com').is('email');
const password = Odac.Var('secret').hash(); // BCrypt
```

### 2. Redirect and Abort
```javascript
if (!user) return Odac.abort(404);
if (!isLoggedIn) return Odac.direct('/login');
```
