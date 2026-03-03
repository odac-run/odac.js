---
name: frontend-forms-api-skill
description: odac.js form submission patterns for parser-generated ODAC forms and predictable AJAX request handling.
metadata:
  tags: frontend, forms, ajax, odac-form, register, login, magic-login
---

# Frontend Forms & API Skill

Handling ODAC AJAX form submissions generated from server-side form parsing.

## Rules
1.  **Bind by form selector**: Use `Odac.form({ form: 'selector' }, callback)` or short form `Odac.form('selector', callback)`.
2.  **Leverage parser-generated forms**: `odac-register`, `odac-login`, and `odac-custom-form` are auto-bound on page load.
3.  **Magic-login binding**: `odac-magic-login-form` is not auto-bound; bind it manually.
4.  **Expect JSON result shape**: Handle `result.success`, `result.message`, `result.redirect`, and `errors` in callback.
5.  **Message/clear control**: Use `messages` and `clear` options for UX behavior.

## Patterns
```javascript
// 1) Bind a parsed custom form
Odac.form('form[data-odac-form]')

// 2) Bind parsed register/login forms explicitly (optional)
Odac.form('form[data-odac-register]')
Odac.form('form[data-odac-login]')

// 3) Bind parsed magic-login form manually
Odac.form('form[data-odac-magic-login]', response => {
  if (response?.result?.success && !response.result.redirect) {
    const info = document.querySelector('[data-status]')
    if (info) info.textContent = response.result.message
  }
})

// 4) Advanced options: disable auto clear and hide success messages
Odac.form(
  {form: 'form[data-odac-form]', clear: false, messages: ['error']},
  response => {
    if (response?.result?.success && response.result.redirect) {
      window.location.href = response.result.redirect
    }
  }
)

// 5) Manual GET request helper
Odac.get('/api/status', data => {
  const status = document.querySelector('[data-api-status]')
  if (status) status.textContent = String(data?.status ?? '')
})
```

## Response Handling Contract
- **Success**: `response.result.success === true`
- **Redirect**: `response.result.redirect` exists when server wants navigation
- **Form errors**: `response.errors.{fieldName}` maps to `odac-form-error="fieldName"`
- **Global form error**: `response.errors._odac_form`
