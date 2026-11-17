---
name: backend-mail-skill
description: Transactional email integration patterns in ODAC using fluent mail APIs, templating, and transport configuration.
metadata:
  tags: backend, mail, smtp, transactional-email, templating, notifications
---

# Backend Mail Skill

Sending transactional emails using the fluent `Odac.Mail` service.

## Core Rules
1.  **Transport**: Mail is delivered through the ODAC Core socket (`ODAC_API_SOCKET`, default `/odac/api.sock`); there is no SMTP transport in the framework.
2.  **Templating**: Templates live in `view/mail/<name>.html` and use the view syntax. Identifier keys of the `send()` data are locals (`{{ name }}`); any key is reachable with `get('key')`. Only keys the template mentions are compiled in, with at most 32 compiled variants per template (then one shared scoped module), so input-derived data cannot grow the cache.
3.  **Components**: reusable mail markup lives in `view/mail/components/` (not `view/components/`) and is used as `<c:name>` with props and slots, like page components. Use inline styles and tables. A component can `<odac:push to="styles">` a `<style>` to `<odac:stack name="styles" />` in the mail head.
4.  **Language**: Send a mail in its recipient's language with `.lang(user.language)` and translate the subject with `.subject(__ => __('Welcome!'))`. Inside the template, `__()`, `<odac translate>`, `Odac.__()` and `Odac.Lang` then use that language. A missing or unsupported code means `lang.default`. Never call `Odac.Lang.set()` before sending a mail: it does not reach the mail (a mail without `.lang()` uses the global `Odac.Lang`, i.e. `lang.default`), and on `global.Odac` in a job it changes the language of everything else sharing it. A string subject is not translated.
5.  **Result**: `send()` resolves to the Core response or `false` (invalid addresses, template error, delivery failure). Always check it.

## Reference Patterns
### 1. Template-based Email
```javascript
const sent = await Odac.Mail('welcome')
  .from('noreply@example.com', 'My App')
  .to(user.email, user.name)
  .subject('Welcome!')
  .send({name: user.name, site: 'ODAC'})
if (!sent) throw new Error('Welcome mail failed')
```

### 1b. Mail in the Recipient's Language
```javascript
await Odac.Mail('welcome')
  .lang(user.language)
  .from('noreply@example.com', 'My App')
  .to(user.email, user.name)
  .subject(__ => __('Welcome!'))
  .send({name: user.name})
```

`view/mail/welcome.html`:
```html
<p>Hello {{ name }}, welcome to {{ site }}!</p>
```

### 2. Inline HTML or Text
```javascript
await Odac.Mail()
  .from('noreply@example.com')
  .to('user@example.com')
  .subject('Ping')
  .html('<h1>Hello!</h1>')
  .send()
```
