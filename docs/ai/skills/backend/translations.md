---
name: backend-translations-i18n-skill
description: Internationalization patterns in ODAC for locale files, placeholders, and multilingual rendering workflows.
metadata:
  tags: backend, i18n, translations, locale, placeholders, multilingual
---

# Backend Translations (i18n) Skill

ODAC provides built-in support for internationalization, allowing for easy multi-language application development.

## Architectural Approach
Translations are managed via JSON files in the `storage/language/` directory. The framework uses a flexible key-based system with support for placeholders.

## Configuration (`odac.json` → `lang`)
All optional; translations work without any.
```json
{"lang": {"default": "tr", "supported": ["tr", "en"], "collect": false, "keep": ["status.*"], "highlightMissing": true}}
```
| Key | Default | Meaning |
|-----|---------|---------|
| `default` | `"en"` | Fallback language and the language keys are written in. Invalid code → `en`. Set it for any non-English site (also enables automatic `<html lang>`). |
| `supported` | files in `storage/language/` | Strict whitelist; `default` always included; non two-letter entries dropped. |
| `collect` | `debug` | Write missing keys to every language file. `false` turns it off in debug too. |
| `keep` | `[]` | Exact keys or `prefix*` that `lang:check` / `lang:prune` treat as used. |
| `highlightMissing` | `false` | Debug only: fallback text rendered as `⟦text⟧`. |

Do not invent other `lang` keys (e.g. a custom path for language files); the directory is fixed to `storage/language/`.

## Core Rules
1.  **Storage**: Place translation files in `storage/language/`, one per two-letter code (e.g., `en.json`, `tr.json`). In debug mode a missing key is added to every language file at once (default language: the key, others: `""`), sorted by key; production only does so with `lang.collect: true`. Never hand-edit key order or add a key to only one file; files are kept in sync automatically. A file that is not valid JSON is never overwritten.
2.  **Tag Usage**: Use `<odac translate>Key</odac>` in views.
3.  **Placeholders**: Use `%s1`, `%s2` in JSON and nested `<odac var="...">` tags in views.
4.  **Backend Access**: Use `Odac.__(key, ...args)` in controllers.
5.  **Context**: When the same source text needs different translations (e.g. "Gül" = Rose / Smile, "Open" = button / status), use `<odac translate context="verb">Gül</odac>` in views and `Odac.__x(key, context, ...args)` in controllers. Do not invent suffixed keys like `"Gül (verb)"` for this.

## Reference Patterns

### 1. View Translations
```html
<!-- Simple -->
<odac translate>Welcome</odac>

<!-- With Placeholders -->
<odac translate>Hello <odac var="user.name" /></odac>
```

### 2. Controller Translations
```javascript
const msg = Odac.__('Welcome back, %s1!', user.name);
```

### 3. Language File Structure
```json
// storage/language/tr.json
{
  "Welcome": "Hoş Geldiniz",
  "Hello %s1": "Merhaba %s1"
}
```

A key used with contexts holds an object of context -> translation (`""` = no context):
```json
// storage/language/en.json
{
  "Gül": {"": "Gül", "flower": "Rose", "verb": "Smile"}
}
```

### 4. Browser Code
`view/js/` code uses `__()` / `__x()` (globals; `Odac.__()` / `Odac.__x()` also work); only the keys it uses are sent to the browser. See `frontend/translations.md`.

### 5. Managing Language Files (CLI)
```bash
npx odac lang:sync           # add keys used in code to every language file
npx odac lang:check --strict # CI: fail on out-of-sync, unused or untranslated keys
npx odac lang:prune --write  # remove keys no code uses (dry run without --write)
```
Keys are read from views (compiled, so placeholders become `%s1`) and from `__()`, `__x()`, `Lang.get()`, `Lang.getx()` calls with string-literal arguments. A non-literal key (`Odac.__(`status.${s}`)`) is reported as dynamic; list such keys in `lang.keep` (`"status.*"` keeps a prefix).

While key collection is on (debug mode), every entry looked up is recorded with its last-used day in `storage/.cache/lang-runtime.json` (git-ignored, per developer). `lang:prune` keeps unused entries found there and lists them apart; `--include-runtime` removes them too. `lang:check` still fails on them (CI has no record), pointing to `lang.keep`. The record only covers code paths that ran, so `lang.keep` remains the durable fix.

## Best Practices
-   **Literal Keys**: Pass string literals to `__()` / `__x()` so `lang:check` and `lang:prune` can see them. For computed keys, add a `lang.keep` pattern; do not rely on the runtime record.
-   **Removing Keys**: Remove keys with `odac lang:prune --write`, not by hand; a key deleted from one file is restored from the others on the next sync.
-   **Descriptive Keys**: Use meaningful keys like `nav.home` or `form.error.required`.
-   **Html Safety**: By default, translations are escaped. Use the `raw` attribute (`<odac translate raw>`) only for trusted HTML.
-   **Supported Languages**: Only languages with a file in `storage/language/` (or listed in `lang.supported`, a strict whitelist) plus `lang.default` are ever served. To add a language, create `storage/language/<code>.json` (`{}` is enough) or add it to `lang.supported`. Client headers never create language files.
-   **Language Selection**: `Odac.Lang.set(code)` if supported, else the most preferred supported `Accept-Language` entry (q values respected), else `lang.default`, then `en`. Read it with `Odac.Lang.current()`; `Odac.Lang.dir()` gives `'rtl'`/`'ltr'`.
-   **Page Language Is Automatic**: When the app declares languages (more than one, or `lang.default` / `lang.supported` set), ODAC replaces `<html lang dir>` of the skeleton with the served language, sends `Content-Language`, and AJAX navigation updates `<html lang dir>`. Never set `lang`/`dir` from a controller variable in the skeleton. A single-language non-English site must set `lang.default`, otherwise its skeleton `lang` is left as written.
-   **Same URL, Several Languages**: A language picked from `Accept-Language` adds `Vary: Accept-Language`; the ODAC Proxy then does not cache the page even with `Odac.cache()`. For public, cacheable or indexed pages put the language in the URL (`/{lang}/...`) and call `Odac.Lang.set()`, which needs no `Vary`. Crawlers send no `Accept-Language` and `hreflang` needs one URL per language, so shared URLs suit pages behind a login. A language read from a cookie makes the page differ per cookie: do not `Odac.cache()` it. Mail and jobs: `Odac.Lang.set(user.language)`.
-   **Live Edits**: Language files may be edited while the app runs; each worker re-checks them every 2 s, and server views, `view/js` translations (next AJAX navigation) and proxy-cached pages follow. Do not build a reload endpoint, a restart hook or a cache-clearing step for translations. A file that is not valid JSON keeps the last valid version served (`WARN "Language file is not valid JSON; serving its last valid version"`, once per broken version) and is retried until fixed. Code that writes language files must write atomically (temp file + rename).
-   **Missing Translations**: Debug mode logs each missing translation once (`WARN "Missing translation"`). `lang.highlightMissing: true` (debug only) renders fallback text as `⟦text⟧`.
-   **Fallback**: A missing or empty (`""`) translation is served from the default language, then as the key itself. `""` marks an entry as "not translated yet"; do not copy the key as the value in non-default languages.
