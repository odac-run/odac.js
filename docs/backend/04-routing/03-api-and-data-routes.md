## 📦 API and Data Routes


#### Class-Based Route Definition (Recommended)

You can route requests to specific methods within a Controller Class using the `ClassName@methodName` syntax. This allows you to group related logic in a single file clearly.

```javascript
// Calls the 'index' method of the class exported in controller/User.js
Odac.Route.get('/users', 'User@index');

// Calls the 'store' method of the class exported in controller/User.js
Odac.Route.post('/users', 'User@store');

// You can also use dot notation for controllers in subdirectories
// controller/Admin/Dashboard.js -> Admin.Dashboard
Odac.Route.get('/admin', 'Admin.Dashboard@index');
```

#### `get(path, controller, options)`
Defines a route that responds to `GET` requests. This is ideal for API endpoints that return data (like JSON).

-   `options`: By default, Odac protects routes from CSRF attacks by checking for a token. For a public API or stateless endpoint, you must disable this by passing `{ token: false }`. If you don't, the server will expect a token and will not return a response if one isn't provided.

`HEAD` requests are answered by the same `get` route, with the same auth and token checks, and the response body is dropped automatically. The controller still runs, so keep `GET` controllers free of side effects. Check `Odac.Request.method === 'head'` if you want to skip expensive work.

```javascript
// An API endpoint at GET /api/users/123
// We disable the token check as this is a public API.
Odac.Route.get('/api/users/{id}', 'api/users.get', { token: false });
```

Parameter values are percent-decoded before the controller sees them: `/api/users/John%20Doe` gives `Odac.request('id') === 'John Doe'`. An encoded slash (`%2F`) stays inside one parameter and decodes to `/`, so validate a parameter before using it in a file path.

#### `post(path, controller, options)`
Defines a route that responds to `POST` requests, typically used for form submissions. The `{ token: false }` option works here as well, but should be used with caution as POST routes are primary targets for CSRF attacks.

```javascript
// A form that posts data to /login
Odac.Route.post('/login', 'auth.login');
```

#### Rate Limiting

Add `rateLimit` to the options of `get`, `post` or any other verb (including `Odac.Route.auth.post`/`auth.get`) to limit how often a client may call the route:

```javascript
// At most 5 messages per minute from each IP
Odac.Route.post('/contact', 'contact.send', {rateLimit: {max: 5, window: 60000}});

// Limit signed-in users by account instead of IP
Odac.Route.auth.post('/api/export', 'api.export', {
  rateLimit: {max: 10, window: 3600000, key: Odac => Odac.Auth.user()?.id}
});
```

| Option | Default | Description |
|--------|---------|-------------|
| `max` | required | Requests allowed per window |
| `window` | `60000` | Window length in milliseconds |
| `key` | client IP | `(Odac) => string`. Return `null`, `undefined` or `''` to exempt a request |

- Each route and verb has its own budget. To give several routes one budget, use the [rate-limit middleware](08-middleware.md#rate-limiting).
- Counters live in `Odac.Ipc`, so the limit covers all workers, and all hosts when IPC uses Redis.
- Windows are fixed and aligned to the clock. A client can send up to `2 × max` requests in a short burst that crosses a window boundary.
- The limit is checked after authentication and before the session, CSRF check and controller. Requests that fail the auth gate of an `auth` route are not counted.
- Every counted response gets `RateLimit-Limit`, `RateLimit-Remaining` and `RateLimit-Reset` (seconds until the window resets) headers. Over the limit, ODAC answers `429 Too Many Requests` with `Retry-After` and doesn't run the controller. You can render your own page with `Odac.Route.error(429, ...)`.
- If the counter store can't be reached, or your `key` function throws, the request goes through and the error is logged. An IPC outage won't block your whole app.
- An invalid declaration (`max: 0`, a `window` that isn't a number) throws when the route file loads.
