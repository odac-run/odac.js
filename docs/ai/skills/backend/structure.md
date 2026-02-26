---
name: backend-structure-services-skill
description: ODAC project organization rules for directory structure, service classes, and request-scoped architecture.
metadata:
  tags: backend, structure, services, architecture, request-scope, organization
---

# Backend Structure & Services Skill

ODAC follows a strictly organized directory structure and focuses on request-scoped architecture. This skill explains how to organize code and use Service Classes.

## Architectural Approach
ODAC uses a request-scoped container. Most logic should be encapsulated in Service Classes (`class/`) which are automatically instantiated and attached to the `Odac` instance for every request.

## Core Rules
1.  **Directory Mapping**:
    -   `route/`: URL definitions using `Odac.Route`.
    -   `controller/`: Request handling logic (Input -> Response).
    -   `class/`: Reusable business logic (Service Classes).
    -   `view/`: HTML/Template files.
    -   `middleware/`: Request interceptors.
    -   `locale/`: Translation JSON files.
2.  **Service Classes**:
    -   Place classes in the `class/` directory.
    -   They are automatically instantiated and attached to `Odac` as `Odac.ClassName`.
    -   They are **Request Scoped** (new instance per request).
3.  **Dependency Injection**: Services receive the framework instance (`Odac`) in their constructor.

## Reference Patterns

### 1. Defining a Service Class (Recommended)
```javascript
// class/User.js
class User {
  constructor(Odac) {
    this.Odac = Odac;
  }

  async getProfile(id) {
    // Access database or auth via this.Odac
    return await this.Odac.DB.table('users').where('id', id).first();
  }
}
module.exports = User;
```

### 2. Using a Service in a Controller
```javascript
// controller/User.js
class User {
  async show(Odac) {
    // Service is automatically available as Odac.User
    const profile = await Odac.User.getProfile(Odac.Request.input('id'));
    
    return Odac.View.make('user.profile', { profile });
  }
}
module.exports = User;
```

## Best Practices
-   **Context Awareness**: Use `this.Odac` inside service classes to access the specific request's state (current user, session, etc.).
-   **Naming**: If a class name conflicts with core services (like `Mail`), it is placed under `Odac.App` (e.g., `Odac.App.Mail`).
-   **Separation**: Keep controllers focused on request/response; move all data processing and business logic to the `class/` directory.
