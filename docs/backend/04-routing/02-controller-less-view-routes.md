## ⚡ Controller-less View Routes

For simple pages that don't require complex logic in a controller, you can render a view directly from your route file by passing a view configuration object as the second parameter.

#### `page(path, { ... })`
This defines a page and immediately tells it which view components to render. You can also pass variables directly in the object, which will be available in your views.

```javascript
Odac.Route.page("/users", {
    // View Configuration
    skeleton: "dashboard",
    header: "dashboard.main",
    sidebar: "dashboard.main",
    footer: "dashboard.main",
    content: "users",

    // Page Variables
    title: "User Management",
    description: "Manage your platform users here"
});
```

This example tells Odac to render the `/users` page using the `dashboard` skeleton. Additionally, `title` and `description` are set as variables and can be accessed in your views using `<odac var="title" />`.

**Page Identifier:** When using view objects, the page identifier (accessible via `Odac.page()` in frontend) is automatically set to the `content` or `all` value. In this example, the page identifier would be `"users"`, allowing you to run page-specific JavaScript:

```javascript
// Frontend
Odac.action({
  page: {
    users: function() {
      console.log('Users page loaded')
    }
  }
})
```

#### `auth.page(path, { ... })`
Similar to `page()`, but requires authentication. Only authenticated users can access this route.

```javascript
// Only authenticated users can see the dashboard
Odac.Route.auth.page('/', {
    skeleton: 'main', 
    content: 'dashboard'
});
```

See [Authentication-Aware Routes](04-authentication-aware-routes.md) for more details.
