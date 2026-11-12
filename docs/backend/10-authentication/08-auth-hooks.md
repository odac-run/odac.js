## 🪝 Login Hooks

Some logic belongs to the moment a user signs in rather than to a route: recording the last login time and IP, keeping an audit trail, or turning away a suspended account. Put it in `hook/auth.js` and ODAC runs it on every sign-in path: password logins (including the zero-config login form), magic links, auto-login after `register()`, and `Odac.Auth.login()` calls in your own controllers.

```
project/
└── hook/
    └── auth.js
```

```javascript
// hook/auth.js
module.exports = {
  // Before a session is issued. Return false to refuse the sign-in.
  async beforeLogin(Odac, {user, method}) {
    if (user.suspended) return false
  },

  // After the session is issued (token stored, cookies set).
  async login(Odac, {user, method}) {
    await Odac.DB.users.where('id', user.id).update({
      last_login_at: new Date(),
      last_login_ip: Odac.Request.ip
    })
  },

  // A sign-in attempt that did not succeed.
  async loginFailed(Odac, {identity, method, reason}) {
    await Odac.DB.login_audit.insert({email: identity.email, ip: Odac.Request.ip, reason, date: new Date()})
  }
}
```

Every handler gets the request's `Odac` instance first, the same one controllers and middleware get, so `Odac.Request`, `Odac.DB` and your service classes are all available. Define only the hooks you need. The file is reloaded on save in development, like middleware.

### Events

| Hook | When it runs | Payload |
|------|--------------|---------|
| `beforeLogin` | Credentials are verified, nothing has been issued yet | `{user, method}` |
| `login` | The session token is stored and the cookies are set | `{user, method}` |
| `loginFailed` | The attempt did not produce a session | `{identity, method, reason}` |

**`method`**: how the user is signing in.

| Value | Source |
|-------|--------|
| `password` | `Odac.Auth.login()` with a password field, including the built-in login form |
| `magic` | A verified magic link, both for existing users and for sign-ups through the link |
| `register` | The auto-login of `Odac.Auth.register()` |
| `direct` | `Odac.Auth.login()` with identity fields only (e.g. `{id}`) |

**`reason`** (`loginFailed` only):

| Value | Meaning |
|-------|---------|
| `invalid` | Wrong credentials, an unknown account, or an invalid or expired magic link |
| `throttled` | The attempt was blocked by login throttling before the credentials were checked |
| `denied` | `beforeLogin` refused the sign-in |

### Rules

- **`beforeLogin` refuses only with an explicit `false`.** Any other return value, including none, lets the user in.
- **`beforeLogin` fails closed.** If it throws, the sign-in is refused and the error is logged. A check that is meant to keep an account out must not let it in because the check itself broke.
- **`login` and `loginFailed` never change the outcome.** An error in them is logged, and the sign-in result stays as it was. The session is already issued when `login` runs.
- **`user` never contains password hashes.** Every configured `auth.passwordField` is removed from the copy the hooks get. `identity` holds only the identity fields of the attempt (e.g. `email`), never the password.
- **A refusal is not a failed password.** It does not count toward login throttling, because the credentials were correct.
- **Resuming a session is not a login.** Requests authenticated by the auth cookie and token rotation run no hooks. The last activity of a session is already kept in the `active` column of the token table (`Odac.Auth.token('active')`).
- **Handlers are awaited.** Keep them short, or start slow work (an email, a webhook) without awaiting it.

### What the user sees when `beforeLogin` refuses

`Odac.Auth.login()` returns `false`, as it does for wrong credentials, so the built-in login form shows "Invalid credentials". A refused magic link fails verification. A refused `register()` still creates the account and returns `{success: true, autoLogin: false}`. If you want to show a specific message (for example "Your account is suspended"), check for that state in your own login controller before calling `Odac.Auth.login()`.

### Only `auth.js`

Hook files are a fixed set, not a general event bus. A file other than `auth.js` in `hook/`, or an export other than `beforeLogin`, `login` and `loginFailed`, is reported in the log when it loads, so a misspelled name does not silently never run.
