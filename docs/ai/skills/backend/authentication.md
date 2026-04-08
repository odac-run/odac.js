---
name: backend-authentication-realtime-skill
description: Secure ODAC authentication patterns for sessions, guards, passwordless flows, and realtime channel protection.
metadata:
  tags: backend, authentication, session, auth-guard, magic-link, realtime, security
---

# Backend Authentication & Realtime Skill

Secure user authentication, session management, and bidirectional communication.

## Architectural Approach
ODAC provides built-in drivers for session handling (Memory/Redis) and multiple authentication flows including standard password-based login and passwordless Magic Links.

## Core Rules
1.  **Auth Guard**: Protect routes using `Odac.Route.auth`.
2.  **Session Integrity**: `Odac.Request.setSession()` MUST be called before accessing `Odac.Request.session()`.
3.  **Password Security**: The framework handles BCrypt hashing automatically via `Odac.Auth`.
4.  **Magic Links**: Use `Odac.Auth.magic(email)` for passwordless flows.
5.  **Token Rotation**: Enterprise-grade rotation is enabled by default. It uses a 60s grace period to prevent race conditions in SPAs.
6.  **Persistence**: Cookies use the configured `maxAge` to persist beyond browser closure.
7.  **Token Accessor**: Use `Odac.Auth.token()` to access the active auth session record (e.g., auth ID, IP, timestamps). Returns `false` if no active session.

## Reference Patterns

### 1. Standard Login & Check
```javascript
// Check if user is logged in
if (await Odac.Auth.check()) {
  const user = Odac.Auth.user()           // Full user object
  const userId = Odac.Auth.user('id')     // Specific user field

  const authRecord = Odac.Auth.token()    // Full auth token record
  const authId = Odac.Auth.token('id')    // Auth session ID from token table
  const authIp = Odac.Auth.token('ip')    // IP address of the session
}

// Log in a user
await Odac.Auth.login({ email, password })

// Log out
await Odac.Auth.logout()
```

### 2. Magic Links (Passwordless)
```javascript
// Generate and send a magic link
const result = await Odac.Auth.magic('user@example.com', {
  redirect: '/dashboard',
  subject: 'Login to MyApp'
});

if (result.success) {
  return { message: 'Link sent!' };
}
```

### 3. Session Management
```javascript
// Get/Set session data
Odac.session('key', 'value');
const val = Odac.session('key');

// Destroy session
Odac.session('key', null);
```

### 4. Realtime Broadcasting (Ipc)
```javascript
// Broadcast to everyone subscibed in this worker cluster
await Odac.Ipc.publish('lobby', { type: 'chat', text: 'Hello!' });

// In your WS handler, listen for Ipc messages
Odac.Ipc.subscribe('lobby', (msg) => {
  Odac.ws.send(msg);
});
```

## Security Best Practices
-   **CSRF Protection**: Native `Odac.form` and `Odac.post` handle CSRF tokens automatically using `{{ TOKEN }}` in views.
-   **Brute Force**: Always use `validator.brute()` on authentication endpoints.
-   **Passwordless Preference**: Consider using Magic Links for enhanced security and better user experience.
