---
name: frontend-navigation-spa-skill
description: Single-page navigation patterns in odac.js for smooth transitions, route control, and lifecycle-safe execution.
metadata:
  tags: frontend, navigation, spa, ajax-navigation, page-lifecycle, transitions, view-transitions
---

# Frontend Navigation & SPA Skill

Smooth transitions and single-page application behavior using `odac.js`.

## Rules
1.  **Selection**: Enable via `Odac.action({ navigate: 'main' })`.
2.  **Exclusion**: Use `data-navigate="false"` or `.no-navigate` class for full reloads.
3.  **Lifecycle**: Use `load` and `page` events to run code after navigation.
4.  **View Transitions**: Add `odac-transition` attribute to elements for native browser View Transition API animations. Zero-config — no JS setup required.

## Patterns
```javascript
Odac.action({
  navigate: {
    update: 'main',
    on: function(page, vars) {
      console.log('Navigated to:', page);
    }
  }
});
```

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
/* Target a specific element's transition */
::view-transition-old(hero) {
  animation: fade-out 0.3s ease;
}
::view-transition-new(hero) {
  animation: fade-in 0.3s ease;
}

/* Slide sidebar from left */
::view-transition-old(sidebar) {
  animation: slide-out-left 0.25s ease;
}
::view-transition-new(sidebar) {
  animation: slide-in-left 0.25s ease;
}
```

### Rules
1. Each `odac-transition` value must be unique within the page.
2. Elements persist across navigations (e.g., shared header) for smooth morphing.
3. No JavaScript configuration needed — attribute-only setup.
4. Falls back to fade animation gracefully on unsupported browsers.
