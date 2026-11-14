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
    -   `hook/`: Framework lifecycle hooks. Only `hook/auth.js` exists (`beforeLogin`, `login`, `loginFailed`); see the authentication skill. Never register framework listeners from route files.
    -   `lang/`: Translation JSON files (source files, commit them; `lang.path` in `odac.json` moves the directory). `storage/` is runtime data and git-ignored; never put translations there.
2.  **Service Classes**:
    -   Place classes in the `class/` directory.
    -   They are automatically instantiated and attached to `Odac` as `Odac.ClassName`.
    -   They are **Request Scoped** (new instance per request).
    -   The loader only scans the **top level** of `class/` — it does **not** recurse into subfolders. A file like `class/billing/Invoice.js` will not be auto-loaded.
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
    const profile = await Odac.User.getProfile(await Odac.request('id'));
    
    return Odac.View.make('user.profile', { profile });
  }
}
module.exports = User;
```

## Best Practices
-   **Context Awareness**: Use `this.Odac` inside service classes to access the specific request's state (current user, session, etc.).
-   **Naming**: If a class name conflicts with core services (like `Mail`), it is placed under `Odac.App` (e.g., `Odac.App.Mail`).
-   **Separation**: Keep controllers focused on request/response; move all data processing and business logic to the `class/` directory.
-   **Splitting large services**: Since subfolders aren't scanned, keep the loadable class file at the root of `class/` and `require()` submodules from a subfolder inside it (plain Node.js `require`, not auto-loading) — e.g. `class/Billing.js` requiring `./billing/invoiceHelpers.js`.

## Runtime: TCP Port and Proxy Socket
-   The app always listens on its TCP port (`PORT`, default `1071`). On an ODAC server, bridge apps also get `ODAC_PROXY_SOCKET` (e.g. `/odac-proxy/http.sock`); the framework then serves the same app on that unix socket too. The server sets it automatically; never set or hard-code it in app code, and never open your own listener for it.
-   TCP remains the fallback: a socket that cannot be created is logged and the app keeps serving TCP. Operators disable sockets server-wide with `ODAC_BACKEND_SOCKETS=off`. Under ODAC (`ODAC_APP=true`) the primary prints `⚡ Turbo Mode` once when the socket is live; its absence means the app is on TCP only.
-   Requests on the socket are trusted proxy traffic, so `Odac.Request.ip` and `Odac.Request.ssl` are the visitor's values exactly as over TCP. Use them; do not read `req.socket.remoteAddress`, which is empty on a unix socket.
-   The server also sets `ODAC_PROXY_KEY`, the secret the proxy signs `X-Odac-Connection-*` with. Never log it, copy it into config or set it yourself.
-   The server also sets `ODAC_APP=true`. Without it (standalone, own nginx, Docker published port) and without `request.trustedProxies`, no peer is trusted and `X-Odac-Connection-*` are ignored. Behind your own proxy, list it in `trustedProxies`; never re-enable trust by setting `ODAC_APP` yourself.
