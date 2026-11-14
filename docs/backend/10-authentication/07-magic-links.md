# Magic Links

Magic links provide a passwordless authentication method where verification links are sent directly to the user's email address. Odac offers both a zero-configuration component and a programmatic API to implement this feature.

## The `<odac:magic-login>` Component

The simplest way to implement magic links is using the built-in view component. This works similarly to the standard `<odac:login>` component but requires no password field.

### Basic Usage

Use the `<odac:magic-login>` tag in your view. If you provide no inner content, Odac will automatically generate a default email input and submit button.

```html
<odac:magic-login redirect="/dashboard" />
```

### Attributes

| Attribute | Description | Default |
|-----------|-------------|---------|
| `redirect` | URL to redirect to after successful login (Required) | `null` |
| `error-redirect` | Page a link that fails to sign in returns to (see [When a link fails](#when-a-link-fails)) | The page the form is on |
| `email-label` | Label text for the default email field | `"Email Address"` |
| `submit-text` | Text for the submit button | `"Send Magic Link"` |

### Customized Usage

You can fully customize the form by adding your own inputs and buttons inside the tag.

```html
<div class="auth-card">
  <h2>Sign In</h2>
  <p>We'll send a login link to your email.</p>
  
  <odac:magic-login redirect="/dashboard">
    <div class="form-group">
        <label for="email">Work Email</label>
        <odac:input name="email" type="email" placeholder="name@company.com" class="form-control">
            <odac:validate rule="required|email" message="Please enter a valid work email"/>
        </odac:input>
    </div>
    
    <odac:submit class="btn btn-primary w-full">Email me a login link</odac:submit>
  </odac:magic-login>
</div>
```

## Backend API

For more complex requirements, such as building a custom API or integrating with other flows, you can use the `Odac.Auth` class directly.

### Requesting a Magic Link

Use `magic` to generate a token and send the email.

```javascript
// In your controller (e.g., AuthController.js)

async sendLink(req, res) {
    const email = req.input('email');
    
    // Returns { success: boolean, message: string, error?: string }
    const result = await Odac.Auth.magic(email, {
        redirect: '/dashboard',       // Redirect after verification
        errorRedirect: '/login',      // Page a failed link returns to (optional)
        subject: 'Log in to MyApp',   // Email subject
        template: 'auth/magic-link'   // View path for the email template
    });
    
    if (result.success) {
        return res.json({ message: result.message });
    } else {
        return res.status(400).json({ error: result.error });
    }
}
```

### Verification Logic

Odac handles the verification route automatically at `/_odac/magic-verify`. For a custom flow, `Odac.Auth.verifyMagicLink(token, email)` returns `{success: true, user}` or `{success: false, code, error}`, with `code` as listed below.

## When a link fails

A link can fail to sign the person in: it expired, it was already used, or your `beforeLogin` hook refused the account. Instead of an error screen, ODAC sends the person back to a page where they can act on it:

1. **The page the form is on (default).** A link requested through `<odac:magic-login>` returns to the page that form was on, and the form shows the error above its fields, in the same element and style as its other errors. Nothing to configure.
2. **A page of your own.** Set `error-redirect` on the form, `errorRedirect` in `Odac.Auth.magic()`, or `auth.magicLinkErrorRedirect` in `odac.json` for every link. The link's own page wins over the config value.
3. **A standalone page.** When neither is known (a link sent from a controller without `errorRedirect`, and no `auth.magicLinkErrorRedirect`), ODAC answers with a simple page that explains the failure and links to `/`.

Error pages must be same-site paths (`/login`); anything else redirects to `/`.

On your own page, read the failure with `Odac.Auth.magicError()`. It returns `{code, message}` or `null`, and the failure is removed from the session once read, so reloading the page does not show it again. Within the same request it keeps returning the same value.

```javascript
// controller/page/link-error.js
module.exports = async function (Odac) {
  const error = Odac.Auth.magicError()
  if (!error) return Odac.direct('/login')

  Odac.set('expired', error.code === 'expired')
  Odac.set('message', error.message)
  Odac.View.set({skeleton: 'main', content: 'auth.link-error'})
}
```

| `code` | Meaning | Default message |
|--------|---------|-----------------|
| `invalid` | Malformed link, already used, or never issued | This sign-in link is invalid or has already been used. Please request a new one. |
| `expired` | The token is correct but past its 15 minutes | This sign-in link has expired. Please request a new one. |
| `denied` | The `beforeLogin` hook refused the account (see Login Hooks) | Sign-in is not allowed for this account. |
| `failed` | Registering or signing in could not complete | Sign-in could not be completed. Please try again. |

Use `code` to show your own (or translated) text; `message` is the English default.

A person who taps an old link again while already signed in with that address is not shown an error: they go to the link's success page as if it had worked.

## Configuration

Magic links usage is configured in your `odac.json` file under the `auth` object.

```json
{
  "url": "https://example.com",         // Public address used in the emailed link (recommended)
  "auth": {
    "magicLinkUrl": "https://example.com", // Optional: overrides "url" for magic links only
    "magicLinkRedirect": "/dashboard",  // Success page when the link names none (Default: /)
    "magicLinkErrorRedirect": "/login", // Page failed links return to when the link names none
    "table": "users",                   // Table where users are stored
    "magicTable": "magic_links",        // Table to store tokens (auto-created)
    "magicLinkRateLimit": 3600000,      // Rate limit window in ms (Default: 1 hour)
    "magicLinkMaxAttempts": 2,          // Max emails per address per window
    "magicLinkMaxAttemptsPerIP": 5,     // Max requests per IP per window
    "magicLinkSessionCooldown": 30000,  // Session cooldown in ms (Default: 30s)
    "passwordless": true,               // Optimization: Skip generating passwords for new users (Default: false)
    "passwordField": "password"         // Column name for password (Default: password)
  }
}
```

### Link address

The emailed link is built from `auth.magicLinkUrl`, then `url` (both may include a path prefix), or the `url` option of `Odac.Auth.magic()`. Without either, ODAC uses the request's `Host` only when the request provably came through the ODAC Proxy or a trusted proxy (see [Client IP behind a proxy](../06-request-and-response/01-the-request-object-what-is-the-user-asking-for.md#client-ip-behind-a-proxy)) and the host is a plain `host[:port]`; otherwise `magic()` returns `{success: false}` and logs why. This stops an attacker from requesting a link for someone else's address with a forged `Host` header so that the login token is delivered to the attacker's domain. Set `url` in production.

## Auto-Registration & Passwordless Mode
 
 When a user verifies a magic link:
 
 1. **Existing User**: They are logged in immediately.
 2. **New User**: An account is automatically created for them (Auto-Registration).
 
 By default, Odac attempts to generate a secure random password for new users to satisfy typical database constraints. However, if your application is purely passwordless (e.g. your storage schema doesn't have a `password` column at all), you should set `"passwordless": true` in your config. This optimizes performance by skipping the password generation step.
 
 Even without this setting, Odac is smart enough to retry registration without a password if the database rejects the initial attempt due to a missing password column.
 
 ## Security & Best Practices
 
 1.  **Rate Limiting**: Odac enforces a 3-layer defense system:
     *   **Session Cooldown**: immediate cookie-based block for rapid clicks (Default: 30s).
     *   **IP Limit**: prevents mass attacks from a single source.
     *   **Email Limit**: prevents spamming a specific user.
 2.  **Token Security**: Tokens are hashed in the database (`token_hash`) using secure hashing algorithms. The raw token is only sent to the user's email and never stored.
 3.  **One-Time Use**: Tokens are immediately deleted upon successful verification or expiration.
 4.  **User Enumeration**: To prevent attackers from checking if an email exists in your system, the `magic` method (and the form) will return a "success" message even if the user does not exist.

## Email Template

If using the default mailer, you can create a custom email template at `views/auth/magic-link.html`. The template receives the following variables:

- `link`: The full verification URL.
- `network`: The hostname.
- `ip`: The request IP address.

```html
<!-- views/auth/magic-link.html -->
<h1>Login Request</h1>
<p>Click the link below to log in to {{ network }}:</p>
<a href="{{ link }}">Login Now</a>
<p>This link was requested from IP: {{ ip }}</p>
```
