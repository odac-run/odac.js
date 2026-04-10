## 🔐 Authentication Basics

The `Odac.Auth` service is your bouncer, managing who gets in and who stays out. It handles user login sessions for you.

#### Letting a User In

`Odac.Auth.login(userId, userData)`

*   `userId`: A unique ID for the user (like their database ID).
*   `userData`: An object with any user info you want to remember, like their username or role.

When you call this, `Auth` creates a secure session for the user.

> **💡 Enterprise Security:** ODAC automatically handles **Token Rotation** every 15 minutes (configurable) and includes built-in **CSRF protection** for all forms. Sessions are persistent across browser restarts by default.

#### Checking the Guest List

*   `await Odac.Auth.check()`: Is the current user logged in? Returns `true` or `false`.
*   `Odac.Auth.user()`: Gets the full user object of the logged-in user.
*   `Odac.Auth.user('id')`: Gets a specific field from the user object (e.g., their ID).
*   `Odac.Auth.token()`: Gets the full auth session record from the token table.
*   `Odac.Auth.token('id')`: Gets the auth session ID from the token table.

#### Showing a User Out

*   `Odac.Auth.logout()`: Ends the user's session and logs them out.

#### Example: A Login Flow
```javascript
// Controller for your login form
module.exports = async function (Odac) {
    const { username, password } = Odac.Request.post

    const loginSuccess = await Odac.Auth.login({ username, password })

    if (loginSuccess) {
        return Odac.direct('/dashboard')
    } else {
        return Odac.direct('/login?error=1')
    }
}

// A protected dashboard page
module.exports = async function (Odac) {
    if (!await Odac.Auth.check()) {
        return Odac.direct('/login')
    }

    const username = Odac.Auth.user('username')
    const authId = Odac.Auth.token('id')  // Auth session ID from token table
    return `Welcome back, ${username}! (Session: ${authId})`
}
```
