---
name: frontend-navigation-spa-skill
description: Single-page navigation patterns in odac.js including smart part diffing, smooth transitions, route control, and lifecycle-safe execution.
metadata:
  tags: frontend, navigation, spa, ajax-navigation, page-lifecycle, transitions, view-transitions, part-diffing
---

# Frontend Navigation & SPA Skill

Smooth transitions and single-page application behavior using `odac.js`.

## How AJAX Navigation Works

ODAC's navigation system is **zero-config** and **server-driven**. On first page load, the framework automatically:
1. Detects all skeleton placeholder wrapper elements (those with `data-odac-navigate` attributes injected by the server).
2. Registers click handlers on all internal links.
3. Reads the initial parts state from `data-odac-parts` on the `<html>` element.

On every subsequent navigation:
1. The client sends the current parts state to the server via `X-Odac-Parts`.
2. The server returns only the parts that changed (`output`) plus the new parts manifest (`parts`).
3. The client fades out and updates only the changed elements. Unchanged parts (e.g. a shared sidebar) are never touched.

## Rules
1.  **Zero-config auto-navigation**: Works automatically when the skeleton has `data-odac-navigate` elements. No `Odac.action()` call needed for basic navigation.
2.  **Manual setup**: Use `Odac.action({ navigate: ... })` to customize selectors, update targets, or add callbacks.
3.  **Exclusion**: Use `data-navigate="false"` attribute or `.no-navigate` class on links to force full page reloads.
4.  **Lifecycle**: Use `load` and `page` events to run code after navigation.
5.  **View Transitions**: Add `odac-transition` attribute to elements for native browser View Transition API animations.

## Patterns

### Auto-navigation (zero-config)
No setup required. As long as the skeleton has properly wrapped placeholders, navigation is automatic.

### Manual navigation setup
```javascript
Odac.action({
  navigate: {
    update: 'main',           // CSS selector of the element to update
    on: function(page, vars) {
      console.log('Navigated to:', page)
    }
  }
})
```

### Programmatic navigation
```javascript
// Navigate to a URL programmatically
Odac.load('/docs/getting-started')

// Navigate without pushing to history
Odac.load('/docs/getting-started', null, false)

// Navigate with a callback
Odac.load('/docs/getting-started', function(page, vars) {
  console.log('Loaded:', page)
})
```

### Excluding links from AJAX navigation
```html
<!-- Full reload for this link -->
<a href="/logout" data-navigate="false">Logout</a>

<!-- Full reload via class -->
<a href="/external-page" class="no-navigate">External</a>
```

## Smart Part Diffing Behavior

The client automatically handles these scenarios without any configuration:

| Scenario | Client behavior |
|----------|----------------|
| Sidebar unchanged between pages | Sidebar DOM untouched, no flicker |
| Sidebar changes between pages | Sidebar fades out → new content → fades in |
| Sidebar removed on new page | Sidebar element content cleared |
| Skeleton changes | Full page reload |
| `content` part | Always updated |

The fade animation only runs on elements that actually receive new content. Unchanged parts stay fully visible throughout the navigation.

## View Transitions (Native Browser API)

Elements with the `odac-transition` attribute automatically use the browser's View Transition API instead of the legacy fade animation. The attribute value becomes the `view-transition-name`, enabling per-element morphing between pages.

### HTML Usage
```html
<header odac-transition="header">Site Header</header>
<nav odac-transition="sidebar">Navigation</nav>
<main>Content updated by AJAX loader</main>
<img odac-transition="hero" src="/hero.jpg" />
```

### Behavior
- When `odac-transition` elements exist and the browser supports View Transition API → native transition is used.
- When no `odac-transition` elements exist or the API is unsupported → legacy fade fallback runs automatically.
- Transition names are applied before the snapshot and cleaned up after the transition completes.
- The attribute value must be unique per page (browser requirement for `view-transition-name`).

### CSS Customization
```css
::view-transition-old(hero) {
  animation: fade-out 0.3s ease;
}
::view-transition-new(hero) {
  animation: fade-in 0.3s ease;
}

::view-transition-old(sidebar) {
  animation: slide-out-left 0.25s ease;
}
::view-transition-new(sidebar) {
  animation: slide-in-left 0.25s ease;
}
```

### Rules
1. Each `odac-transition` value must be unique within the page.
2. Elements that persist across navigations (e.g. shared header) produce smooth morphing animations.
3. No JavaScript configuration needed — attribute-only setup.
4. Falls back to fade animation gracefully on unsupported browsers.
