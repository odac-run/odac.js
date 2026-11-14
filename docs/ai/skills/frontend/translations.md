---
name: frontend-translations-skill
description: Translating text in ODAC browser code (view/js) with __() and __x(), and what the server sends to the browser.
metadata:
  tags: frontend, i18n, translations, odac-js, security
---

# Frontend Translations Skill

Browser code in `view/js/` translates text with the application's language files.

## Architectural Approach
The server reads the keys used in `view/js/` from the source and embeds only those, already translated into the page's language (parent-language and default-language fallbacks applied), as `<script type="application/json" id="odac-lang">`. AJAX navigation refreshes them only when the language or their content changes (the browser reports `X-Odac-Lang: <lang>:<version>`; a language file edited on the server reaches it on the next navigation), and sets `<html lang dir>` to the served language (do not update them by hand). The browser never writes to language files; in debug mode the server adds `view/js/` keys to every language file itself.

## Core Rules
1.  **API**: `__(key, ...args)`, `__x(key, context, ...args)`, `Odac.lang()` (active canonical code such as `tr` or `pt-BR`, or `null`; pass it straight to `Intl`). Placeholders: `%s` (in order) or `%s1`, `%s2`. The globals `__` / `__x` alias `Odac.__` / `Odac.__x`; if another script already defined a global `__`, ODAC keeps it (console warning) and only `Odac.__()` works, so use `Odac.__()` in code that shares the page with other i18n libraries.
2.  **Literal Keys Only**: Keys must be string literals (`__('Shipped')`); computed keys (`__(`status.${s}`)`) are never sent and come back untranslated. Map values to literal keys instead.
3.  **Plain Text**: Insert results with `textContent` or as attribute values, never `innerHTML`; placeholder values are often user input.
4.  **No Custom Loaders**: Do not fetch language JSON files, expose the language directory (`lang/`) or build an endpoint for translations; the built-in mechanism sends exactly the needed subset.

## Reference Patterns
```javascript
// view/js/app.js
Odac.action({
  load() {
    document.querySelector('#save').textContent = __('Save')
    document.querySelector('#count').textContent = __('%s1 items selected', items.length)
    document.querySelector('#smile').textContent = __x('Gül', 'verb')
    const date = new Intl.DateTimeFormat(Odac.lang() ?? 'en').format(new Date())
  }
})
```

```javascript
// Computed key -> map to literals so the scanner sees them
const labels = {shipped: __('Shipped'), pending: __('Pending')}
el.textContent = labels[order.status]
```

See `backend/translations.md` for language files, contexts and the `odac lang:*` commands.
