## 🌍 Translations in the Browser

Browser code in `view/js/` can use the same language files as your views with `Odac.__()` and `Odac.__x()`:

```javascript
// view/js/app.js
Odac.action({
  load() {
    const button = document.querySelector('#save')
    button.textContent = Odac.__('Save')

    const status = document.querySelector('#status')
    status.textContent = Odac.__('%s1 items selected', selected.length)

    // Same text, different meaning: see "Context" in the backend translation guide
    document.querySelector('#smile').textContent = Odac.__x('Gül', 'verb')
  }
})
```

Placeholders work as on the server: `%s` is replaced in order, `%s1`, `%s2` by position. `Odac.lang()` returns the language the page is served in (e.g. `'tr'`), useful for `Intl.DateTimeFormat` and similar APIs.

### What Is Sent to the Browser

ODAC reads the translation keys your `view/js/` code uses straight from its source and sends **only those**, already translated into the page's language (falling back to the default language). The rest of your language files, such as admin screens or internal messages, never reaches the browser.

- Translations are embedded in the page as a JSON block (`<script type="application/json" id="odac-lang">`), escaped like `Odac.share()` data, so no extra request is made.
- On AJAX navigation the browser reports its language and receives new translations only when the language changed.
- If your `view/js/` code uses no translations, nothing is added to the page.
- The browser never writes to language files. In development (`debug` mode), keys used in `view/js/` are added to the language files by the server, like every other key, and changes to `view/js/` are picked up automatically. In production the sources are scanned once at startup.

### Use Literal Keys

The keys are found by reading the source, so pass string literals:

```javascript
Odac.__('Order shipped')            // ✅ found
Odac.__(`status.${order.status}`)   // ❌ cannot be found, returned untranslated
```

For a key built at runtime, map values to literal keys instead:

```javascript
const labels = {shipped: Odac.__('Shipped'), pending: Odac.__('Pending')}
element.textContent = labels[order.status]
```

`npx odac lang:check` lists calls whose key is not a literal.

### Security

`Odac.__()` returns plain text. Insert it with `textContent` (or as an attribute value), **not** with `innerHTML`: placeholder values often come from user input, and a translation inserted as HTML would execute any markup they contain.

```javascript
element.textContent = Odac.__('Hello %s1', user.name)   // ✅
element.innerHTML = Odac.__('Hello %s1', user.name)     // ❌ XSS if the name contains HTML
```
