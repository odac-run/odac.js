---
name: backend-routing-middleware-skill
description: High-performance ODAC routing and middleware orchestration for secure request pipelines and scalable URL mapping.
metadata:
  tags: backend, routing, middleware, pipeline, auth, performance, url-matching
---

# Backend Routing & Middleware Skill

Routing manages the request pipeline, directing URLs to controllers while applying security and business logic via middlewares.

## Architectural Approach
Routes are defined in the `route/` directory. ODAC uses a two-phase routing strategy: O(1) exact matches followed by an indexed segment-based parametric lookup for maximum performance.

## Core Rules
1.  **Methods**: 
    -   `Odac.Route.page(url, controller)`: For HTML views (GET).
    -   `Odac.Route.get(url, controller)`: Targeted GET requests. Also serves HEAD (same auth/token gates, body dropped; `Odac.Request.method` is `'head'`).
    -   `Odac.Route.post(url, controller)`: Sensitive POST requests (CSRF enabled by default).
    -   `Odac.Route.ws(url, controller)`: Bidirectional and persistent WebSocket connections.
    -   `Odac.Route.authWs(url, controller)`: Authenticated WebSocket connections.
2.  **Parameters**: Use `{id}` syntax for dynamic segments. Accessed via `Odac.request('id')`. Values arrive percent-decoded (`%2F` becomes `/` inside the value), so validate them before file-system use.
3.  **Middlewares**: Chain logic using `.use('name')`. Global middlewares reside in `middleware/`.
4.  **Error Handling**: Use `Odac.Route.error(code, controller)` for custom 404/500 pages.
5.  **Auth Guard**: `Odac.Route.auth` automatically checks authentication before running the route.
6.  **Rate Limiting**: Built in. Never hand-roll a limiter with an in-memory `Map`; it is per worker and wrong under the cluster.
    -   Per route: `{rateLimit: {max, window = 60000, key}}` in the options of `get`/`post`/any verb (and `auth.get`/`auth.post`). Each route + verb has its own budget.
    -   Shared budget across routes: `Odac.Route.use(Odac.Route.rateLimit({max, window, name}))`. Give it a stable `name`.
    -   `key(Odac)` defaults to the client IP. Return `null`/`undefined`/`''` to exempt a request.
    -   Counted through `Odac.Ipc`, so the limit covers all workers (and all hosts with Redis). Fixed, clock-aligned windows; up to `2 × max` in a burst across a boundary.
    -   Runs after the auth gate, before session/CSRF/controller. Over the limit: `429` + `Retry-After` (customize with `Odac.Route.error(429, ...)`). Every counted response carries `RateLimit-Limit/Remaining/Reset`.
    -   Fails open (logged) if IPC is unreachable or `key` throws. An invalid declaration throws at route-file load.
    -   WebSocket `rateLimit` on `ws()` is different: it limits messages per connection.

## Reference Patterns

### 1. Standard Web Routes
```javascript
// page(path, controller)
Odac.Route.page('/', 'Home'); 
Odac.Route.page('/profile/{username}', 'User@profile');
```

### 2. Protected Routes & Middlewares
```javascript
// Only authenticated admins can see stats
Odac.Route.auth
  .use('is_admin')
  .page('/admin/stats', 'Admin@stats');
```

### 3. Error Pages mapping
```javascript
Odac.Route.error(404, 'errors/NotFound');
Odac.Route.error(500, 'errors/ServerError');
```

### 4. API Routes
```javascript
// Disable CSRF token check for external APIs
Odac.Route.post('/api/webhook', 'Api@webhook', { token: false });
```

### 5. Rate-Limited Routes
```javascript
// 5 requests per minute per IP
Odac.Route.post('/contact', 'Contact@send', { rateLimit: { max: 5, window: 60000 } });

// Per account instead of per IP
Odac.Route.auth.post('/api/export', 'Api@export', {
  rateLimit: { max: 10, window: 3600000, key: Odac => Odac.Auth.user()?.id }
});

// One budget for a group of routes
Odac.Route
  .use(Odac.Route.rateLimit({ max: 100, name: 'api-writes' }))
  .post('/api/upload', 'Api@upload')
  .post('/api/import', 'Api@import');
```

### 6. Realtime & WebSocket Routes
```javascript
// Public WebSocket
Odac.Route.ws('/chat', 'Chat');

// Authenticated WebSocket with path params
Odac.Route.authWs('/game/{roomId}', 'Game@join');
```

## Best Practices
-   **Method Specification**: Use `.page()` for views to enable AJAX navigation compatibility.
-   **Static First**: Prefer exact URL matches over parametric ones where possible (faster).
-   **Controller Isolation**: Place error controllers in `controller/errors/` for better organization.
-   **Parametric Safety**: Do not use too many nested dynamic segments in a single route.
-   **Throttle Expensive Endpoints**: Put `rateLimit` on public form targets, search, exports and uploads. Login is already brute-force protected by the framework.
