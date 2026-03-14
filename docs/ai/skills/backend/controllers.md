---
name: backend-controllers-skill
description: Best practices for ODAC controller architecture, class-based routing, and clean request handling boundaries.
metadata:
  tags: backend, controllers, class-based, route-mapping, architecture, maintainability
---

# Backend Controllers Skill

Controllers are the bridge between routes and views/services. This skill covers how to write clean, professional controllers in ODAC.

## Architectural Approach
ODAC supports both simple function-based controllers and class-based controllers. For enterprise-grade applications, class-based controllers are strongly recommended for better organization.

## Core Rules
1.  **Class-Based Controllers**: Use classes to group related logic. Each method handles a specific route.
2.  **Naming Convention**: Controllers are usually PascalCase (e.g., `UserController.js`).
3.  **Route Mapping**: Use the `ControllerName@MethodName` syntax in routes.
4.  **Automatic Injection**: Methods receive the `Odac` instance as the first argument automatically.

## Reference Patterns

### 1. Class-Based Controller (Recommended)
```javascript
// controller/User.js
class User {
  // GET /users
  async index(Odac) {
    const users = await Odac.Service.get('User').all();
    return Odac.View.make('user.list', { users });
  }

  // GET /users/{id}
  async show(Odac) {
    const id = await Odac.request('id');
    const user = await Odac.Service.get('User').find(id);
    return Odac.return(user);
  }

  // POST /users
  async store(Odac) {
    const data = Odac.Request.post();
    // Logic to save user...
    return { success: true };
  }
}

module.exports = User;
```

### 2. WebSocket Controller
```javascript
// controller/ws/Chat.js
module.exports = function(Odac) {
  const ws = Odac.ws; // The WebSocket client instance

  ws.on('message', (data) => {
    console.log('Received:', data);
    // Broadcast to everyone else
    ws.broadcast({ sender: ws.id, text: data.text });
  });

  ws.on('close', () => {
    console.log('Client disconnected:', ws.id);
  });

  // Optional: send welcome message
  ws.send({ type: 'info', message: 'Connected to Chat!' });
};
```

### 3. Simple Function-Based Controller
```javascript
// controller/Home.js
module.exports = function(Odac) {
  return "Welcome to ODAC!";
};
```

### 4. Usage in Routes
```javascript
// route/web.js
Odac.Route.get('/users', 'User@index');
Odac.Route.get('/home', 'Home'); // Auto-calls the exported function
```

## Best Practices
-   **Keep it Thin**: Controllers should only handle request parsing and response formatting. Core logic belongs in **Services**.
-   **Asynchronous Handling**: Always use `async/await` for database or network operations.
-   **Structured Returns**: Use `Odac.return()` for JSON or `Odac.View.make()` for rendering.
