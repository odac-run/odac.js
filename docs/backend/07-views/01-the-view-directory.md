## 📁 View System Overview

Odac's view system creates dynamic HTML pages by combining skeleton (layout) and view (content) files. This system provides a modular structure by keeping page layout and content separate.

### Directory Structure

Your project uses two main directories:

- `skeleton/` - Main page skeletons (layout files)
- `view/` - Page contents and components

### Skeleton Files

Skeleton files define the overall structure of your page. They contain the basic HTML structure including head and body, and host placeholders for content.

Example: `skeleton/main.html`

```html
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>My Website</title>
    <meta name="description" content="Welcome to my website">
    <link rel="stylesheet" href="/assets/css/style.css">
</head>
<body>
    <header>
        {{ HEADER }}
    </header>
    
    <main>
        {{ CONTENT }}
    </main>
    
    <footer>
        {{ FOOTER }}
    </footer>
</body>
</html>
```

**Important Rules for Placeholders:**

1. **Each placeholder must be wrapped in its own HTML tag** — This allows the AJAX navigation system to identify and independently update each section.
2. **Never place placeholders directly next to each other** — Bad: `{{ HEADER }}{{ CONTENT }}`, Good: `<header>{{ HEADER }}</header><main>{{ CONTENT }}</main>`
3. **Placeholders are uppercase** — `{{ HEADER }}`, `{{ CONTENT }}`, `{{ FOOTER }}`
4. **Use semantic HTML tags** — `<header>`, `<main>`, `<footer>`, `<aside>`, `<nav>`, etc.
5. **Unset placeholders are automatically removed** — If a controller does not call `set('sidebar', ...)`, the `{{ SIDEBAR }}` placeholder is silently removed from the output. No stale text leaks into the HTML.

**Why wrap in tags?**
When using AJAX navigation, the system automatically injects `data-odac-navigate` attributes onto the wrapper elements of each placeholder. This enables the smart part-diffing engine to update only the sections that actually changed between navigations.

**Note:** Skeleton files support only view part placeholders (uppercase). For dynamic content like page titles, use a view part for the `<head>` section or place a `<title>` tag inside the content view.

### View Files

View files contain the content that will be placed into the placeholders within the skeleton. They are organized under the `view/` directory.

Example directory structure:

```
view/
├── header/
│   ├── main.html
│   └── dashboard.html
├── content/
│   ├── home.html
│   └── about.html
├── sidebar/
│   └── docs.html
└── footer/
    └── main.html
```

### Smart AJAX Navigation & Part Diffing

When navigating between pages via AJAX, ODAC uses a **server-driven part diffing** system to minimize unnecessary work:

- **Unchanged parts are skipped** — If `sidebar` points to the same view file on both the current and next page, the server does not re-render it and the client does not update its DOM. The sidebar stays visible and untouched.
- **Changed parts are updated** — Only parts whose view path changed are rendered and sent to the client.
- **Removed parts are cleared** — If the next page does not set a part that the current page had (e.g. navigating away from a page with a sidebar), that element's content is emptied.
- **`content` is always refreshed** — Because content views are typically URL-dependent (e.g. `/{id}`), the `content` part is always re-rendered regardless of view path.
- **Skeleton change triggers full reload** — If the next page uses a different skeleton, a full page navigation is performed automatically.

This means a shared sidebar, header, or footer that does not change between pages will never flicker or reload during AJAX navigation.

#### Force-refresh a part

If a part's view path stays the same but its rendered output changes per request (e.g. a sidebar with an active menu state), mark it with `{ refresh: true }`:

```javascript
// This sidebar will re-render on every navigation even if the view path is unchanged
Odac.View.set('sidebar', 'docs.nav', { refresh: true })
```
