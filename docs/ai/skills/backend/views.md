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
2.  **Data Binding**:
    -   `{{ key }}`: Escaped output (Standard).
    -   `{!! key !!}`: Raw output (Use with extreme caution).
3.  **Conditionals**: Use `<odac:if condition="VAR"> ... </odac:if>`.
4.  **Looping**: Use `<odac:for in="ARRAY" value="ITEM"> ... </odac:for>` or the performance-optimized `[[odac_for ...]]`.
5.  **Server-Side JS**: Use `<script:odac>` for complex calculations during rendering.

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
<!-- Display Variable -->
<h1>{{ title }}</h1>

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

## Security Best Practices
-   **Always use `{{ }}`**: Standard tags prevent XSS.
-   **Limit `<script:odac>`**: Do not perform database queries or API calls inside views; keep them in the controller.
-   **Partial Awareness**: Use `<odac:include view="path.to.view" />` for reusable components.
