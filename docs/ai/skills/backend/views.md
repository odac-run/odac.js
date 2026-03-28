---
name: backend-views-templates-skill
description: ODAC server-side rendering guidelines for skeleton layouts, smart part diffing, template syntax, and safe output rendering.
metadata:
  tags: backend, views, templates, ssr, xss-protection, skeleton, rendering, part-diffing, ajax-navigation
---

# Backend Views & Templates Skill

High-performance server-side rendering using ODAC's optimized template engine with smart AJAX part diffing.

## Architectural Approach
Views in ODAC are logic-light but powerful. They support automatic XSS protection, high-performance looping, server-side JavaScript execution via `<script:odac>`, and a smart AJAX navigation system that only updates parts of the page that actually changed.

## Core Rules
1.  **Skeleton Architecture**: Use `Odac.View.skeleton('name')` to wrap content in a layout.
2.  **Part Setting**: Use `Odac.View.set(partName, viewPath)` to fill skeleton placeholders.
3.  **Data Binding — Two Equivalent Syntaxes**:
    -   `<odac var="key" />`: Tag-based output (HTML-escaped, XSS-safe).
    -   `{{ key }}`: Inline/interpolation output (HTML-escaped, XSS-safe). Identical behavior to `<odac var>`.
    -   `<odac var="key" raw />` or `{!! key !!}`: Raw output (use with extreme caution).
4.  **Choosing the Right Syntax**:
    -   **Inside HTML attributes** (`src`, `alt`, `href`, `class`, `value`, etc.) → Always prefer `{{ }}`.
    -   **Inline within text or mixed HTML** → Prefer `{{ }}` for short interpolations.
    -   **Standalone block output** → Prefer `<odac var="" />` for structural clarity.
5.  **Conditionals**: Use `<odac:if condition="VAR"> ... </odac:if>`.
6.  **Looping**: Use `<odac:for in="ARRAY" value="ITEM"> ... </odac:for>`.
7.  **Server-Side JS**: Use `<script:odac>` for complex calculations during rendering.

## Smart Part Diffing (AJAX Navigation)

ODAC uses a **server-driven part diffing** system during AJAX navigation. Understanding this is critical for building multi-section layouts correctly.

### How it works
- The client tracks which view file each part is currently showing.
- On every AJAX navigation, it sends this state to the server via `X-Odac-Parts`.
- The server compares the new page's parts against the client's current state and **only renders parts that changed**.
- The client only updates DOM elements that received new content.

### Rules
| Scenario | Behavior |
|----------|----------|
| Part view path unchanged | Skipped — not re-rendered, DOM untouched |
| Part view path changed | Re-rendered and DOM updated |
| Part removed on new page | DOM element content cleared |
| Skeleton changed | Full page reload |
| `content` part | **Always** re-rendered (URL-dependent by nature) |

### Force-refresh a part
If a part's view path stays the same but its rendered output changes per request (e.g. a sidebar with an active menu state):

```javascript
// Always re-renders on AJAX navigation even if view path is unchanged
Odac.View.set('sidebar', 'docs.nav', { refresh: true })
```

### Skeleton placeholder rules
- Each `{{ PLACEHOLDER }}` must be wrapped in its own HTML element.
- The engine auto-injects `data-odac-navigate` on wrapper elements — do not add manually.
- Unset placeholders are silently removed from the final HTML output.

```html
<!-- skeleton/main.html -->
<aside>{{ SIDEBAR }}</aside>   <!-- auto-gets data-odac-navigate="sidebar" -->
<main>{{ CONTENT }}</main>     <!-- auto-gets data-odac-navigate="content" -->
```

## Reference Patterns

### 1. Standard Page with Shared Layout
```javascript
// controller/docs/page.js
module.exports = function (Odac) {
  Odac.View
    .skeleton('main')
    .set('sidebar', 'docs.nav')   // shared — skipped if unchanged on next navigate
    .set('content', 'docs.intro') // always re-rendered
}
```

### 2. Sidebar with Active State (force refresh)
```javascript
// controller/docs/page.js
module.exports = function (Odac) {
  Odac.View
    .skeleton('main')
    .set('sidebar', 'docs.nav', { refresh: true }) // re-renders every navigate
    .set('content', 'docs.intro')
}
```

### 3. Page Without Sidebar
```javascript
// controller/home.js — navigating here clears the sidebar DOM element
module.exports = function (Odac) {
  Odac.View
    .skeleton('main')
    .set('content', 'home')
  // sidebar not set → its DOM element is emptied on AJAX navigation
}
```

### 4. Template Syntax Reference
```html
<!-- Standalone block output — prefer <odac var> -->
<h1><odac var="title" /></h1>

<!-- Inside attributes — prefer {{ }} -->
<img src="{{ product.image }}" alt="{{ product.name }}">
<a href="/user/{{ user.id }}" class="btn {{ isActive ? 'active' : '' }}">Profile</a>

<!-- Inline text interpolation -->
<p>Welcome, {{ user.name }}. You have {{ notifications }} new messages.</p>

<!-- Conditional -->
<odac:if condition="stats.users > 100">
  <span class="badge">Popular!</span>
</odac:if>

<!-- Loop -->
<odac:for in="users" value="user">
  <li>{{ user.name }}</li>
</odac:for>
```

### 5. Backend JavaScript (`<script:odac>`)
```html
<script:odac>
  const total = items.reduce((sum, i) => sum + i.price, 0)
  const tax = total * 0.18
</script:odac>

<p>Subtotal: ${{ total }}</p>
<p>Tax: ${{ tax }}</p>
```

## Security Best Practices
-   **Both `{{ }}` and `<odac var>` are XSS-safe**: Both apply HTML escaping by default.
-   **Raw output requires trust**: Only use `raw` / `{!! !!}` with content you fully control. Never with user input.
-   **Limit `<script:odac>`**: Do not perform database queries or API calls inside views; keep them in the controller.
