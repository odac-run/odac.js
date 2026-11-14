---
name: backend-views-templates-skill
description: ODAC server-side rendering guidelines for skeleton layouts, smart part diffing, template syntax, components, and safe output rendering.
metadata:
  tags: backend, views, templates, ssr, xss-protection, skeleton, rendering, part-diffing, ajax-navigation, components, slots, props
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
    -   `<odac get="key" />`: Query Parameter output (HTML-escaped, XSS-safe).
    -   `<odac var="key" raw />`, `<odac get="key" raw />` or `{!! key !!}`: Raw output (use with extreme caution).
4.  **Choosing the Right Syntax**:
    -   **Inside HTML attributes** (`src`, `alt`, `href`, `class`, `value`, etc.) → Always prefer `{{ }}`.
    -   **Inline within text or mixed HTML** → Prefer `{{ }}` for short interpolations.
    -   **Standalone block output** → Prefer `<odac var="" />` for structural clarity.
5.  **Conditionals**: Use `<odac:if condition="VAR"> ... </odac:if>`.
6.  **Looping**: Use `<odac:for in="ARRAY" value="ITEM"> ... </odac:for>`.
7.  **Server-Side JS**: Use `<script:odac>` for complex calculations during rendering.
8.  **Variables are locals**: every `Odac.set()` key that is a plain identifier is a template variable (`{{ user.name }}`). Keys like `first-name` and reserved names (`class`, `html`, `props`, `attrs`, `slots`, `get`, `Odac`) are not; read them with `get('first-name')`. Reading a key that was never set throws (500): set optional values to `null` or test `typeof x !== 'undefined'`.
9.  **Components**: repeated markup belongs in `view/components/*.html`, used as `<c:name>` (see below). Do not copy the same markup across views.

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

<!-- Query parameter from URL (/page?q=search) -->
<p>Search Results for: <odac get="q" /></p>
<div class="raw-content"><odac get="htmlContent" raw /></div>

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

## Components

Reusable markup in `view/components/`. File name = tag name: `view/components/card.html` → `<c:card>`, `view/components/ui/modal.html` → `<c:ui.modal>`. Long form: `<odac:component name="ui.modal">`.

### Rules
- **Declare props** once at the top: `<odac:props title="'Untitled'" count="0" :user />`. Values are JS expressions used as defaults (may use earlier props and `await`); a prop without a value is **required** (missing → 500). Declared props are variables (`{{ title }}`); every passed value is also on `props` (kebab-case → camelCase).
- **Passing values**: `title="Text"` (string), `title="No. {{ id }}"` (interpolated string), `:user="expr"` (any JS value), `disabled` (`true`), `max-items="5"` → `maxItems`.
- **Pass-through attributes**: undeclared attributes (`class`, `id`, `data-*`, `aria-*`) go to `attrs`. Print with `{!! attrs !!}` on the root element. Merge classes with `{!! attrs.class('card') !!}`; never write `class="..."` next to `{!! attrs !!}` (duplicate attribute). `attrs.except('id')`, `attrs.only('id')`, `attrs.has('id')`, `attrs.get('id')`. `true` → bare attribute, `false`/`null`/`undefined` → omitted. Values are escaped.
- **Slots**: children = default slot, printed with `<odac:slot />` (children of that tag are the fallback). Named: provide with `<odac:slot name="footer">...</odac:slot>` inside the component tag; print with `<odac:slot name="footer" />` or `<odac:slot name="footer">fallback</odac:slot>` in the component. Inside a component tag a named slot **with content** always provides (at any depth); the default slot always prints, so a wrapper forwards with `<c:card><odac:slot>fallback</odac:slot></c:card>` and prints its own named slot with a fallback as `<odac:slot name="footer"><odac:slot name="footer">fallback</odac:slot></odac:slot>`. Test presence with `slots.footer`.
- **Scope is isolated**: a component sees only its props plus `Odac`, `get()`, `__()`. Pass page data explicitly (`:user="user"`). Slot content renders in the caller's scope (loop variables work).
- **Nesting and recursion** are supported (trees: a component rendering itself). Depth limit 50 → 500.
- **Errors** (missing component, missing required prop, throw inside, mismatched `</c:x>`) answer 500 and log the file, line and the chain of views that used it.
- A leading `:` on a component attribute is an ODAC expression; for Alpine/Vue bindings on a component tag use the long form (`x-bind:class`).
- **Dynamic**: `<odac:component :is="'widgets.' + w.type" :w="w" />`. The name is validated (no `../`), but map user input to allowed names instead of passing it through.
- **Once per response**: `<style once>`, `<script once>`, `<odac:once>...</odac:once>`. Use them for a component's CSS/JS instead of repeating it per instance. Plain `<script>`/`<style>` content is not scanned for component tags.
- **Push / stack**: `<odac:push to="head">...</odac:push>` sends content to `<odac:stack name="head" />` (usually in the skeleton `<head>`, and a `scripts` stack before `</body>`). Identical pushes print once; AJAX navigation sends them as `stacks` and the client inserts missing ones (scripts run after the content swap). Put component stylesheets/scripts in pushes, not inline per instance.
- **Lazy**: `<c:comments lazy :post-id="post.id">placeholder</c:comments>` renders the component in a second request (`/_odac/lazy`) when it nears the viewport; `lazy="load"` right after page load. Children are the placeholder (no slots). Props are encrypted into the page (≤ 3 KB serialized, tamper-proof): pass ids and query inside the component (`<script:odac>` with `await Odac.DB...`). It renders with the visitor's own session/auth; tokens from a signed-in render only work for that user, guest tokens for anyone, 7-day expiry. Still check access in the component for private data. Use `lazy="load"` for per-user bits (user menu, cart) of pages cached with `Odac.cache()`. Not in mail. Multi-server apps must set `encrypt.key` (otherwise the key is generated in `storage/.key`, which must survive deploys).
- Components render in views, parts and mail templates (mail uses `view/mail/components/`). Skeletons do not render components; they hold `<odac:stack>` markers.
- **From a controller**: `return Odac.View.component('cart.item', {item, class: 'highlight'})` renders the same markup as a string (AJAX/WebSocket partial updates).

### Reference Pattern
```html
<!-- view/components/modal.html -->
<odac:props title />
<div {!! attrs.class('modal') !!}>
  <header>{{ title }}</header>
  <div class="body"><odac:slot>Nothing here.</odac:slot></div>
  <odac:if condition="slots.footer"><footer><odac:slot name="footer" /></footer></odac:if>
</div>

<!-- view/content/users.html -->
<odac:for in="users" value="user">
  <c:modal title="Delete {{ user.name }}" id="delete-{{ user.id }}">
    <p>This cannot be undone.</p>
    <odac:slot name="footer"><c:button variant="danger" :disabled="!user.deletable">Delete</c:button></odac:slot>
  </c:modal>
</odac:for>
```

## Security Best Practices
-   **Both `{{ }}` and `<odac var>` are XSS-safe**: Both apply HTML escaping by default.
-   **Raw output requires trust**: Only use `raw` / `{!! !!}` with content you fully control. Never with user input.
-   **Component values are escaped where printed**: `{{ prop }}` and `{!! attrs !!}` escape; there is no raw prop. Pass trusted HTML through a slot instead.
-   **Limit `<script:odac>`**: Do not perform database queries or API calls inside views; keep them in the controller.

## Render Errors and Production Caching
-   **A throwing view answers 500**: the error is logged with view file and line, `Odac.cache()` headers are dropped, and the `Odac.Route.error(500, ...)` page renders. Never rely on an empty region as a fallback.
-   **`<html lang dir>` are the framework's**: when the app declares languages, the skeleton's `lang`/`dir` are replaced with the served language per request (see `backend/translations.md`). Keep a static `lang` in the skeleton only as the value for single-language apps.
-   **Production caches view lookups**: compiled views, file existence and skeletons are cached per process when `debug` is off; restart (deploy) to pick up new view files.
