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

```javascript
// An API endpoint at GET /api/users/123
// We disable the token check as this is a public API.
Odac.Route.get('/api/users/{id}', 'api/users.get', { token: false });
```

#### `post(path, controller, options)`
Defines a route that responds to `POST` requests, typically used for form submissions. The `{ token: false }` option works here as well, but should be used with caution as POST routes are primary targets for CSRF attacks.

```javascript
// A form that posts data to /login
Odac.Route.post('/login', 'auth.login');
```

