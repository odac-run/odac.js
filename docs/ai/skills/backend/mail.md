# Backend Mail Skill

Sending transactional emails using the fluent `Odac.Mail` service.

## Core Rules
1.  **Transport**: Configured via `odac.json` (SMTP, etc.).
2.  **Templating**: Combine with `Odac.Var().replace()` for dynamic content.
3.  **Methods**: Use `Odac.Mail.send({ ... })`.

## Reference Patterns
### 1. Simple Email
```javascript
await Odac.Mail.send({
  to: 'user@example.com',
  subject: 'Welcome!',
  body: '<h1>Hello!</h1>',
  type: 'html' // default is text
});
```

### 2. Template-based Email
```javascript
const template = 'Hello {{ name }}, welcome to {{ site }}!';
const body = Odac.Var(template).replace({
  '{{ name }}': user.name,
  '{{ site }}': 'ODAC'
});

await Odac.Mail.send({
  to: user.email,
  subject: 'Registration Success',
  body: body
});
```
