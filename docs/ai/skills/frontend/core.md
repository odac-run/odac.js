# Frontend Core Skill

The foundational principles of the `odac.js` library for building reactive and interactive user interfaces.

## Architectural Approach
Frontend logic is organized into **Actions** using `Odac.action()`. This method centralizes event listeners, page-specific code, and lifecycle hooks.

## Core Rules
1.  **Centralization**: All frontend logic should be defined within `Odac.action({})`.
2.  **Lifecycle Hooks**:
    -   `start`: Fires once when the script initializes.
    -   `load`: Fires after every page load (including AJAX navigations).
3.  **Page Scoping**: Use the `page: { name: fn }` object to isolate code to specific routes.
4.  **Persistent Storage**: Use `odac.storage(key, value)` for a secure LocalStorage wrapper.

## Reference Patterns

### 1. Global Lifecycle & Page Scoping
```javascript
Odac.action({
  // Global - runs on every page
  load: function() {
    console.log('Page ready');
  },

  // Scoped - runs only on the 'dashboard' page
  page: {
    dashboard: function(vars) {
      console.log('Welcome to Dashboard', vars);
    }
  }
});
```

### 2. Event Handling
```javascript
Odac.action({
  click: {
    '#save-btn': function() {
      alert('Saving...');
    },
    '.delete-item': 'fn.confirmDelete' // Reference a custom function
  },
  
  fn: {
    confirmDelete: function() {
      return confirm('Are you sure?');
    }
  }
});
```

### 3. Data Utilities
```javascript
// Accessing data shared from backend (Odac.share)
const user = odac.data('user');

// Using Storage wrapper
odac.storage('theme', 'dark');
const theme = odac.storage('theme');
```

## Best Practices
-   **Clean Selectors**: Use ID or specific data-attributes for event listeners to avoid conflicts.
-   **No Inline JS**: Move all logic from HTML attributes (onclick, etc.) into `Odac.action()`.
-   **Shared State**: Use `odac.data()` to pass complex objects from the backend once per request.
