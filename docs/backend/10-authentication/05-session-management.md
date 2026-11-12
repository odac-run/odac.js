## ⏰ Session Management

Odac uses a secure cookie-based session system with automatic expiration and cleanup.

### How Sessions Work

When a user logs in, Odac creates a session token stored in secure cookies:

```javascript
// Login creates a session
await Odac.Auth.login({email, password})

// Session is automatically checked on each request
if (await Odac.Auth.check()) {
  const user = Odac.Auth.user(null)
}
```

### Session Expiration

Sessions use a **sliding window** approach (similar to NextAuth.js):

- **maxAge**: Maximum session lifetime (default: 30 days)
- **updateAge**: How often to refresh the session (default: 1 day)

**How it works:**
1. User logs in, session created
2. User is active, session refreshed every 24 hours
3. User inactive for 30 days, session expires
4. Active users stay logged in indefinitely (up to 30 days of inactivity)

### Token Rotation (Enterprise Grade)

Odac implements a non-blocking **Refresh Token Rotation** mechanism to enhance security:

- **rotationAge**: How often to rotate tokens (default: 15 minutes)
- **rotationGrace**: When a token is rotated, the old token remains valid for **30 seconds** (default) so concurrent requests from Single Page Applications and retries after a lost response still pass.

**How it works:**
1. A request is made with an active token older than `rotationAge`.
2. Exactly one request claims the rotation; concurrent requests with the same token stay signed in without minting extra tokens.
3. Odac issues a brand new token set and sends them as cookies.
4. The old token is marked as "rotated" and stays valid for the grace period.
5. If the client presents the old token again after 5 seconds (its rotation response was lost), it receives a new token set once.
6. After the grace period, the old token is naturally expired.

### Configuration

Configure session behavior in `odac.json`:

```json
{
  "auth": {
    "table": "users",
    "token": "user_tokens",
    "maxAge": 2592000000,
    "updateAge": 86400000,
    "rotationAge": 900000,
    "rotationGrace": 30000,
    "rotation": true
  }
}
```

**Options:**

- `maxAge` (milliseconds): Maximum inactivity period before session expires. **Note:** Cookies also use this value for persistence.
  - Default: `2592000000` (30 days)
  - Example: `604800000` (7 days)

- `updateAge` (milliseconds): How often to update the session timestamp (heartbeat)
  - Default: `86400000` (1 day)
  - Example: `3600000` (1 hour)

- `rotationAge` (milliseconds): How often to rotate the session tokens
  - Default: `900000` (15 minutes)

- `rotation` (boolean): Enable or disable token rotation
  - Default: `true`

### Common Configurations

**Short sessions (banking apps):**
```json
{
  "auth": {
    "maxAge": 900000,
    "updateAge": 300000
  }
}
```
- 15 minutes inactivity timeout
- Refresh every 5 minutes

**Long sessions (social apps):**
```json
{
  "auth": {
    "maxAge": 7776000000,
    "updateAge": 86400000
  }
}
```
- 90 days inactivity timeout
- Refresh every 1 day

**Standard sessions (most apps):**
```json
{
  "auth": {
    "maxAge": 2592000000,
    "updateAge": 86400000
  }
}
```
- 30 days inactivity timeout (default)
- Refresh every 1 day (default)

### Automatic Cleanup

Expired sessions are automatically cleaned up:

- **When**: During each login
- **What**: Removes sessions older than `maxAge`
- **Why**: Keeps database clean and performant

No manual cleanup needed!

### Session Security

Sessions are protected with:

- **httpOnly cookies**: JavaScript cannot access tokens
- **secure flag**: Only sent over HTTPS
- **sameSite: Strict**: CSRF protection
- **bcrypt hashing**: Tokens are hashed in database
- **browser fingerprinting**: Tied to user agent

### Manual Session Management

**Logout current session:**
```javascript
await Odac.Auth.logout()
```
Only the current device is signed out; other devices of the same user keep their sessions.

Signing in moves the visitor to a new session identifier (session data is carried over), so an identifier obtained before login cannot be reused afterwards.

**Check session status:**
```javascript
const isLoggedIn = await Odac.Auth.check()
```

**Get user info:**
```javascript
const user = Odac.Auth.user()          // Full user object
const email = Odac.Auth.user('email')  // Specific user field
```

**Get auth session record:**
```javascript
const authRecord = Odac.Auth.token()       // Full token record from auth table
const authId = Odac.Auth.token('id')       // Auth session ID
const sessionIp = Odac.Auth.token('ip')    // IP address of the session
const sessionDate = Odac.Auth.token('date') // When the session was created
```

> **Note:** `token()` returns `false` if no active session exists. It is populated after a successful `check()` call.

### Custom Session Data

If you need to store your own data in the session (e.g. shopping cart ID, preferences), use the `Odac.session()` helper:

```javascript
// Store data
Odac.session('theme', 'dark')

// Retrieve data
const theme = Odac.session('theme')
```

How the session store behaves:

- **Created on first write.** Reading from a visitor without a session returns `null` and stores nothing, so bots and health checks do not fill the store.
- **Sliding expiry.** A session expires 7 days after its last activity (not after its creation). Activity is recorded at most once per hour, and the `odac_session` cookie's expiry is renewed with it.
- **Bound to the browser.** The session is tied to the User-Agent with version numbers removed: a browser update keeps the session, a different browser or platform does not.
- **CSRF tokens** (`Odac.token()`) are stored one key per token, so tokens issued in parallel by different workers are never lost. Each token is valid once, for the session lifetime.


### Best Practices

1. **Choose appropriate timeouts** based on your app's security needs
2. **Use shorter sessions** for sensitive operations (banking, admin panels)
3. **Use longer sessions** for convenience apps (social media, content sites)
4. **Don't set updateAge too low** - it causes unnecessary database writes
5. **Monitor session table size** - cleanup runs automatically but check periodically

### Troubleshooting

**Users getting logged out too quickly:**
- Increase `maxAge` value
- Check if users are actually inactive

**Too many database writes:**
- Increase `updateAge` value
- Default (1 day) is usually optimal

**Session table growing too large:**
- Check if cleanup is running (happens on login)
- Manually clean old sessions if needed:
```javascript
const cutoffDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
await Odac.DB.user_tokens
  .where('active', '<', cutoffDate)
  .delete()
```
