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
2.  **Templating**: Templates live in `view/mail/<name>.html` and use the view syntax. Identifier keys of the `send()` data are locals (`{{ name }}`); any key is reachable with `get('key')`.
3.  **Components**: reusable mail markup lives in `view/mail/components/` (not `view/components/`) and is used as `<c:name>` with props and slots, like page components. Use inline styles and tables. A component can `<odac:push to="styles">` a `<style>` to `<odac:stack name="styles" />` in the mail head.
4.  **Result**: `send()` resolves to the Core response or `false` (invalid addresses, template error, delivery failure). Always check it.

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
