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
    -   `Odac.Route.get(url, controller)`: Targeted GET requests.
    -   `Odac.Route.post(url, controller)`: Sensitive POST requests (CSRF enabled by default).
2.  **Parameters**: Use `{id}` syntax for dynamic segments. Accessed via `Odac.request('id')`.
3.  **Middlewares**: Chain logic using `.use('name')`. Global middlewares reside in `middleware/`.
4.  **Error Handling**: Use `Odac.Route.error(code, controller)` for custom 404/500 pages.
5.  **Auth Guard**: `Odac.Route.auth` automatically checks authentication before running the route.

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

## Best Practices
-   **Method Specification**: Use `.page()` for views to enable AJAX navigation compatibility.
-   **Static First**: Prefer exact URL matches over parametric ones where possible (faster).
-   **Controller Isolation**: Place error controllers in `controller/errors/` for better organization.
-   **Parametric Safety**: Do not use too many nested dynamic segments in a single route.
