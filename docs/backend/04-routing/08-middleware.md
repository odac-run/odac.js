## 🔗 Middleware

Middleware allows you to run code before your controllers execute. Perfect for authentication, logging, rate limiting, and more.

### Creating Middleware

Create middleware files in the `middleware/` directory:

```javascript
// middleware/auth.js
module.exports = async (Odac) => {
  if (!await Odac.Auth.check()) {
    return Odac.direct('/login')  // Redirect to login
  }
  // No return = continue to next middleware or controller
}
```

**Middleware Rules:**
- Return `false` → Stop execution (403 Forbidden)
- Return `Odac.abort(code)` → Stop with custom error code
- Return `Odac.direct(url)` → Stop and redirect
- Return nothing or `true` → Continue to next middleware/controller

### Using Middleware

#### Single Route
```javascript
Odac.Route
  .use('logger')
  .page('/contact', 'contact')
```

#### Multiple Routes
```javascript
Odac.Route
  .use('cors')
  .page('/api/users', 'api.users')
  .page('/api/posts', 'api.posts')
  .get('/api/stats', 'api.stats')
```

#### Multiple Middlewares
```javascript
Odac.Route
  .use('cors', 'rateLimit')
  .post('/api/upload', 'api.upload')
```

#### With Auth Routes

`Odac.Route.auth` already requires authentication. You can add additional middleware on top:

```javascript
// Admin-only routes (requires login + admin role)
Odac.Route.auth
  .use('admin')
  .page('/admin/dashboard', 'admin.dashboard')
  .page('/admin/users', 'admin.users')
  .post('/admin/settings', 'admin.settings')
```

```javascript
// Premium user routes (requires login + premium subscription)
Odac.Route.auth
  .use('premium')
  .page('/premium/content', 'premium.content')
  .page('/premium/downloads', 'premium.downloads')
```

```javascript
// Multiple middlewares with auth
Odac.Route.auth
  .use('verified', 'rateLimit')
  .post('/api/sensitive', 'api.sensitive')
```

### Middleware Examples

#### Authentication
```javascript
// middleware/auth.js
module.exports = async (Odac) => {
  if (!await Odac.Auth.check()) {
    return Odac.direct('/login')
  }
}
```

#### Admin Check
```javascript
// middleware/admin.js
module.exports = async (Odac) => {
  const user = await Odac.Auth.user()
  if (!user || user.role !== 'admin') {
    return false  // 403 Forbidden
  }
}
```

#### CORS Headers
```javascript
// middleware/cors.js
module.exports = async (Odac) => {
  Odac.Request.header('Access-Control-Allow-Origin', '*')
  Odac.Request.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE')
}
```

#### Rate Limiting

ODAC has a built-in rate limiter, so you don't need to write one. `Odac.Route.rateLimit()` returns a middleware that gives every route it wraps one shared budget. The count is shared by all workers, and by all hosts when IPC uses Redis:

```javascript
// middleware/rateLimit.js
module.exports = Odac.Route.rateLimit({max: 100, window: 60000, name: 'api'})
```

```javascript
// route/www.js — /api/upload and /api/import share 100 requests per minute per IP
Odac.Route
  .use('rateLimit')
  .post('/api/upload', 'api.upload')
  .post('/api/import', 'api.import')
```

Use the `rateLimit` route option when one route needs its own limit. See [API and Data Routes](03-api-and-data-routes.md#rate-limiting) for every option and the response headers.

#### Premium Check with View
```javascript
// middleware/premium.js
module.exports = async (Odac) => {
  const user = await Odac.Auth.user()
  
  if (!user.isPremium) {
    return Odac.View.render('premium/upgrade', {
      user: user,
      currentPage: Odac.Request.url
    })
  }
}
```

#### Logging
```javascript
// middleware/logger.js
module.exports = async (Odac) => {
  console.log(`${Odac.Request.method} ${Odac.Request.url}`)
}
```

#### Inline Middleware
```javascript
Odac.Route
  .use(async (Odac) => {
    console.log('Custom middleware')
  })
  .page('/special', 'special')
```

### Complete Example

```javascript
// route/www.js

// Public routes
Odac.Route.page('/', 'index')
Odac.Route.page('/about', 'about')

// API routes with CORS
Odac.Route
  .use('cors', 'rateLimit')
  .get('/api/public', 'api.public')
  .post('/api/contact', 'api.contact')

// User routes (requires login)
Odac.Route.auth
  .page('/profile', 'profile')
  .page('/settings', 'settings')
  .post('/api/update', 'update')

// Admin routes (requires login + admin role)
Odac.Route.auth
  .use('admin')
  .page('/admin', 'admin.index')
  .page('/admin/users', 'admin.users')
  .post('/admin/delete', 'admin.delete')
```

### Hot Reloading

Middleware files are automatically reloaded when changed (every 5 seconds), just like controllers and routes. No server restart needed during development.
