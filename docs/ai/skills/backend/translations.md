# Backend Translations (i18n) Skill

ODAC provides built-in support for internationalization, allowing for easy multi-language application development.

## Architectural Approach
Translations are managed via JSON files in the `locale/` directory. The framework uses a flexible key-based system with support for placeholders.

## Core Rules
1.  **Storage**: Place translation files in `locale/` (e.g., `en.json`, `tr.json`).
2.  **Tag Usage**: Use `<odac translate>Key</odac>` in views.
3.  **Placeholders**: Use `%s1`, `%s2` in JSON and nested `<odac var="...">` tags in views.
4.  **Backend Access**: Use `Odac.__(key, ...args)` in controllers.

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

### 3. Locale JSON Structure
```json
// locale/tr.json
{
  "Welcome": "Hoş Geldiniz",
  "Hello %s1": "Merhaba %s1"
}
```

## Best Practices
-   **Descriptive Keys**: Use meaningful keys like `nav.home` or `form.error.required`.
-   **Html Safety**: By default, translations are escaped. Use the `raw` attribute (`<odac translate raw>`) only for trusted HTML.
-   **Language Selection**: Set the language at the start of a request via `Odac.Lang.setLanguage('tr')`.
