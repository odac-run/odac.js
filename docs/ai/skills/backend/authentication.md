---
name: backend-authentication-realtime-skill
description: Secure ODAC authentication patterns for sessions, guards, passwordless flows, login hooks, and realtime channel protection.
metadata:
  tags: backend, authentication, session, auth-guard, magic-link, login-hooks, realtime, security
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
5.  **Token Rotation**: Enterprise-grade rotation is enabled by default. The rotated token stays valid for a 30 s grace period (`auth.rotationGrace`) to prevent race conditions in SPAs; concurrent requests rotate only once.
6.  **Persistence**: Cookies use the configured `maxAge` to persist beyond browser closure.
7.  **Token Accessor**: Use `Odac.Auth.token()` to access the active auth session record (e.g., auth ID, IP, timestamps). Returns `false` if no active session.
8.  **Login Hooks**: Sign-in side effects (last login time/IP, audit logs) and sign-in vetoes (suspended accounts) go in `hook/auth.js`, never in individual login controllers: the hooks run on every path (password, built-in login form, magic link, `register()` auto-login, direct `Odac.Auth.login()`). Resumed sessions and token rotation run no hooks.

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

### 2. Login Hooks (`hook/auth.js`)
```javascript
// hook/auth.js — every handler gets the request's Odac instance first
module.exports = {
  // Credentials verified, nothing issued yet. Only an explicit `false` refuses.
  // Throwing also refuses (fails closed). A refusal does not count toward throttling.
  async beforeLogin(Odac, {user, method}) {
    if (user.suspended) return false
  },

  // Token stored and cookies set. Errors are logged; the sign-in still succeeds.
  async login(Odac, {user, method}) {
    await Odac.DB.users.where('id', user.id).update({last_login_at: new Date(), last_login_ip: Odac.Request.ip})
  },

  // reason: 'invalid' | 'expired' (magic link) | 'throttled' | 'denied'. identity never contains the password.
  async loginFailed(Odac, {identity, method, reason}) {}
}
```
- `method`: `'password'`, `'magic'` (existing user or sign-up via link), `'register'` (auto-login), `'direct'` (identity-only `login()`).
- `user` is a copy without the `auth.passwordField` hash(es); use it instead of `Odac.Auth.user()` inside hooks.
- A refusal makes `login()` return `false` (form shows "Invalid credentials"), fails `verifyMagicLink()` with `{success: false, code: 'denied', error: 'Login failed'}`, and makes `register()` return `{success: true, autoLogin: false}`. For a custom message, check the account state in your controller before calling `login()`.
- Only `auth.js` and these three exports are recognized; anything else is logged as unknown at load time.

### 3. Magic Links (Passwordless)
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
- **Failed links never end on an error screen.** `/_odac/magic-verify` redirects a failed link to, in order: the link's `errorRedirect` (`<odac:magic-login error-redirect="...">` or `magic(email, {errorRedirect})`), `auth.magicLinkErrorRedirect`, else a standalone 400 page. `<odac:magic-login>` defaults `error-redirect` to the page it is rendered on and shows the error itself — do not build a separate error page unless the design needs one.
- **Custom error page**: read `Odac.Auth.magicError()` → `{code, message}` or `null` (read once per session, stable within the request). Branch on `code`, not on `message` (English default text).
- **Codes** (also on `verifyMagicLink()` results): `invalid` (malformed, used, unknown), `expired`, `denied` (beforeLogin hook), `failed` (registration/sign-in error).
- Error pages must be same-site paths; others become `/`. A second tap by a person already signed in with that email goes to the success page.

### 4. Session Management
```javascript
// Get/Set session data
Odac.session('key', 'value');
const val = Odac.session('key');

// Destroy session
Odac.session('key', null);
```
- Session records are created on the first write only; reads never create one.
- Expiry slides: 7 days after the last activity (recorded at most hourly).
- Bound to the version-free User-Agent: browser updates keep the session.

### 5. Realtime Broadcasting (Ipc)
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
-   **Brute Force**: `Odac.Auth.login()` throttles wrong passwords (5 per account+IP, 50 per IP, 15 min window; `auth.loginMaxAttempts`, `auth.loginMaxAttemptsPerIP`, `auth.loginWindow` in ms). Use `Odac.Auth.loginThrottled(credentials)` to show a lockout message, and `validator.brute()` for other sensitive forms.
-   **Passwordless Preference**: Consider using Magic Links for enhanced security and better user experience.
