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

Odac handles the verification route automatically at `/_odac/magic-verify`. However, if you are building a custom flow, you might interact with the underlying data model directly using `Odac.DB`.

## Configuration

Magic links usage is configured in your `config.json` file under the `auth` object.

```json
{
  "auth": {
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
