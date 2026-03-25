---
name: backend-views-templates-skill
description: ODAC server-side rendering guidelines for template performance, skeleton layouts, and safe output rendering.
metadata:
  tags: backend, views, templates, ssr, xss-protection, skeleton, rendering
---

# Backend Views & Templates Skill

High-performance server-side rendering using ODAC's optimized template engine.

## Architectural Approach
Views in ODAC are logic-light but powerful. They support automatic XSS protection, high-performance looping, and server-side JavaScript execution via `<script:odac>`.

## Core Rules
1.  **Skeleton Architecture**: Use `Odac.View.skeleton('name')` to wrap content in a layout.
2.  **Data Binding — Two Equivalent Syntaxes**:
    -   `<odac var="key" />`: Tag-based output (HTML-escaped, XSS-safe).
    -   `{{ key }}`: Inline/interpolation output (HTML-escaped, XSS-safe). Identical behavior to `<odac var>`.
    -   `<odac var="key" raw />` or `{!! key !!}`: Raw output (Use with extreme caution).
3.  **Choosing the Right Syntax**:
    -   **Inside HTML attributes** (`src`, `alt`, `href`, `class`, `value`, etc.) → Always prefer `{{ }}`. It reads naturally and keeps markup clean.
    -   **Inline within text or mixed HTML** → Prefer `{{ }}` for short interpolations.
    -   **Standalone block output** (the variable is the only content of an element) → Prefer `<odac var="" />` for structural clarity and IDE support.
    -   Both syntaxes compile to the same engine output. The choice is about readability, not functionality.
4.  **Conditionals**: Use `<odac:if condition="VAR"> ... </odac:if>`.
5.  **Looping**: Use `<odac:for in="ARRAY" value="ITEM"> ... </odac:for>` or the performance-optimized `[[odac_for ...]]`.
6.  **Server-Side JS**: Use `<script:odac>` for complex calculations during rendering.

## Reference Patterns

### 1. The Controller to View Flow
```javascript
// Controller
Odac.View.skeleton('main');
Odac.View.set({
  title: 'Dashboard',
  stats: { users: 150, orders: 45 }
});
```

### 2. Template Syntax Reference
```html
<!-- Standalone block output — prefer <odac var> -->
<h1><odac var="title" /></h1>

<!-- Inside attributes — prefer {{ }} -->
<img src="{{ product.image }}" alt="{{ product.name }}">
<a href="/user/{{ user.id }}" class="btn {{ isActive ? 'active' : '' }}">Profile</a>
<input type="text" value="{{ query }}">

<!-- Inline text interpolation — prefer {{ }} -->
<p>Welcome, {{ user.name }}. You have {{ notifications }} new messages.</p>
<span>${{ product.price }}</span>

<!-- Conditional -->
<odac:if condition="stats.users > 100">
  <span class="badge">Popular!</span>
</odac:if>

<!-- Performance Loop -->
[[odac_for user in users]]
  <li>{{ user.name }}</li>
[[odac_endfor]]
```

### 3. Backend JavaScript (`<script:odac>`)
Perfect for calculations that shouldn't clutter the controller but are too complex for simple tags.
```html
<script:odac>
  // Runs on the SERVER during rendering
  const total = items.reduce((sum, i) => sum + i.price, 0);
  const tax = total * 0.18;
</script:odac>

<p>Subtotal: ${{ total }}</p>
<p>Tax: ${{ tax }}</p>
```

## Syntax Selection Guide

| Context | Preferred Syntax | Example |
|---------|-----------------|---------|
| HTML attributes (`src`, `href`, `alt`, `class`, `value`) | `{{ }}` | `<img src="{{ photo.url }}" alt="{{ photo.caption }}">` |
| Inline text within elements | `{{ }}` | `<p>Hello, {{ user.name }}</p>` |
| Standalone element content | `<odac var />` | `<h1><odac var="title" /></h1>` |
| Raw HTML output (trusted only) | `<odac var raw />` or `{!! !!}` | `<div><odac var="content" raw /></div>` |

## Security Best Practices
-   **Both `{{ }}` and `<odac var>` are XSS-safe**: Both apply HTML escaping by default. Use either with confidence.
-   **Raw output requires trust**: Only use `raw` / `{!! !!}` with content you fully control. Never with user input.
-   **Limit `<script:odac>`**: Do not perform database queries or API calls inside views; keep them in the controller.
-   **Partial Awareness**: Use `<odac:include view="path.to.view" />` for reusable components.
