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

## Core Rules
1.  **Storage**: Place translation files in `storage/language/`, one per two-letter code (e.g., `en.json`, `tr.json`). In debug mode missing keys are appended automatically; production only does so with `lang.collect: true`.
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

## Best Practices
-   **Descriptive Keys**: Use meaningful keys like `nav.home` or `form.error.required`.
-   **Html Safety**: By default, translations are escaped. Use the `raw` attribute (`<odac translate raw>`) only for trusted HTML.
-   **Supported Languages**: Only languages with a file in `storage/language/` (or listed in `lang.supported`, a strict whitelist) plus `lang.default` are ever served. To add a language, create `storage/language/<code>.json` (`{}` is enough) or add it to `lang.supported`. Client headers never create language files.
-   **Language Selection**: `Odac.Lang.set(code)` if supported, else the most preferred supported `Accept-Language` entry (q values respected), else `lang.default`, then `en`. Read it with `Odac.Lang.current()`.
-   **Fallback**: A missing or empty (`""`) translation is served from the default language, then as the key itself. `""` marks an entry as "not translated yet"; do not copy the key as the value in non-default languages.
