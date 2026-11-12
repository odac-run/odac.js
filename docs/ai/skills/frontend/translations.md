---
name: frontend-translations-skill
description: Translating text in ODAC browser code (view/js) with Odac.__() and Odac.__x(), and what the server sends to the browser.
metadata:
  tags: frontend, i18n, translations, odac-js, security
---

# Frontend Translations Skill

Browser code in `view/js/` translates text with the application's language files.

## Architectural Approach
The server reads the keys used in `view/js/` from the source and embeds only those, already translated into the page's language (default-language fallback applied), as `<script type="application/json" id="odac-lang">`. AJAX navigation refreshes them only when the language changes. The browser never writes to language files; in debug mode the server adds `view/js/` keys to every language file itself.

## Core Rules
1.  **API**: `Odac.__(key, ...args)`, `Odac.__x(key, context, ...args)`, `Odac.lang()` (active code or `null`). Placeholders: `%s` (in order) or `%s1`, `%s2`.
2.  **Literal Keys Only**: Keys must be string literals (`Odac.__('Shipped')`); computed keys (`Odac.__(`status.${s}`)`) are never sent and come back untranslated. Map values to literal keys instead.
3.  **Plain Text**: Insert results with `textContent` or as attribute values, never `innerHTML`; placeholder values are often user input.
4.  **No Custom Loaders**: Do not fetch language JSON files, expose `storage/language/` or build an endpoint for translations; the built-in mechanism sends exactly the needed subset.

## Reference Patterns
```javascript
// view/js/app.js
Odac.action({
  load() {
    document.querySelector('#save').textContent = Odac.__('Save')
    document.querySelector('#count').textContent = Odac.__('%s1 items selected', items.length)
    document.querySelector('#smile').textContent = Odac.__x('Gül', 'verb')
    const date = new Intl.DateTimeFormat(Odac.lang() ?? 'en').format(new Date())
  }
})
```

```javascript
// Computed key -> map to literals so the scanner sees them
const labels = {shipped: Odac.__('Shipped'), pending: Odac.__('Pending')}
el.textContent = labels[order.status]
```

See `backend/translations.md` for language files, contexts and the `odac lang:*` commands.
