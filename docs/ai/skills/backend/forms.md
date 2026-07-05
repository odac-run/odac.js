---
name: backend-forms-validation-skill
description: Practical ODAC form usage patterns for register/login, magic-login, custom actions, and automatic database insert.
metadata:
  tags: backend, forms, validation, register, login, magic-login, request-processing
---

# Backend Forms & Validation Skill

ODAC forms for validation, authentication flows, and safe request handling.

## Rules
1.  **Use ODAC form tags**: Prefer `<odac:register>`, `<odac:login>`, `<odac:magic-login>`, `<odac:form>` instead of manual raw form handlers.
2.  **Do not add manual hidden security fields**: Keep forms clean and use ODAC defaults.
3.  **Validation in template**: Define rules with `<odac:validate rule="..." message="..."/>`; they become both frontend HTML constraints and backend validator checks.
4.  **Server-side enrichment**: Use `<odac:set>` for trusted fields (`compute`, `value`, `callback`, `if-empty`) instead of taking these values from user input.
5.  **Action vs table**: In `<odac:form>`, use `table="..."` for automatic insert or `action="Class.method"` for custom business logic.

## Form Type Variants

### 1) Register Form
```html
<odac:register redirect="/dashboard" autologin="true">
  <odac:input name="email" type="email" label="Email">
    <odac:validate rule="required|email" message="Valid email required"/>
  </odac:input>

  <odac:input name="password" type="password" label="Password">
    <odac:validate rule="required|minlen:8" message="Min 8 chars"/>
  </odac:input>

  <odac:set name="created_at" compute="now"/>
  <odac:submit text="Register" loading="Processing..."/>
</odac:register>
```

### 2) Login Form
```html
<odac:login redirect="/panel">
  <odac:input name="email" type="email" label="Email">
    <odac:validate rule="required|email" message="Email required"/>
  </odac:input>

  <odac:input name="password" type="password" label="Password">
    <odac:validate rule="required" message="Password required"/>
  </odac:input>

  <odac:submit text="Login" loading="Logging in..."/>
</odac:login>
```

### 3) Magic Login Form
```html
<odac:magic-login redirect="/dashboard" email-label="Work Email" submit-text="Send Link" />
```

```html
<odac:magic-login redirect="/dashboard">
  <odac:input name="email" type="email" label="Email">
    <odac:validate rule="required|email" message="Valid email required"/>
  </odac:input>
  <odac:submit text="Send Magic Link" loading="Sending..."/>
</odac:magic-login>
```

### 4) Custom Form with Automatic DB Insert
```html
<odac:form table="waitlist" redirect="/" success="Thank you!" clear="true">
  <odac:input name="email" type="email" label="Email">
    <odac:validate rule="required|email|unique" message="Email already exists"/>
  </odac:input>

  <odac:set name="created_at" compute="now"/>
  <odac:set name="ip" compute="ip"/>
  <odac:submit text="Join" loading="Joining..."/>
</odac:form>
```

### 5) Custom Form with Controller Action
```html
<odac:form action="Contact.submit" clear="false">
  <odac:input name="subject" type="text" label="Subject">
    <odac:validate rule="required|minlen:3" message="Subject is too short"/>
  </odac:input>
  <odac:submit text="Send" loading="Sending..."/>
</odac:form>
```

```javascript
module.exports = class Contact {
  constructor(Odac) {
    this.Odac = Odac
  }

  async submit(form) {
    const data = form.data
    if (!data.subject) return form.error('subject', 'Subject required')
    return form.success('Message sent', '/thank-you')
  }
}
```

## Field-Level Variants
- **Input types**: `text`, `email`, `password`, `number`, `url`, `textarea`, `checkbox`, `file`.
- **Validation mapping**: `required|minlen|maxlen|min|max|alpha|alphanumeric|numeric|email|url|accepted|maxsize|minsize|mimetype|ext|maxfiles`.
- **Pass-through attrs**: Unrecognized `<odac:input ...>` attributes are preserved into generated HTML input/textarea/input[type=file].
- **Skip persistence**: Use `skip` on `<odac:input>` to validate a field but exclude it from final payload.
- **Unique shorthand**: `unique` attribute on `<odac:input>` enables auth-register uniqueness list.

## File Upload Fields

File inputs work end-to-end with zero-config validation, like all other input types:

```html
<odac:form action="Profile.saveAvatar" enctype="multipart/form-data">
  <odac:input type="file" name="avatar" label="Avatar">
    <odac:validate rule="required|maxsize:2MB|mimetype:image/png,image/jpeg" message="PNG/JPEG, max 2MB"/>
  </odac:input>
  <odac:submit text="Save"/>
</odac:form>
```

### File Rules
- **`required`**: file must be present (at least one file for `multiple`).
- **`maxsize:2MB`** / **`minsize:10KB`**: size constraints (supports B, KB, MB, GB suffixes); enforced server-side via busboy limits + client-side byte checks.
- **`mimetype:image/png,image/jpeg`** (alias **`accept:`**): comma-separated MIME list; wildcards like `image/*` supported. Validated via claimed MIME, extension map, and (for images) magic-byte sniffing.
- **`ext:jpg,png`**: file extension whitelist (case-insensitive).
- **`maxfiles:3`**: max file count for `multiple` inputs.

### Controller Access
In action forms, access uploaded files via `form.file(name)`:
```javascript
async saveAvatar(form) {
  const avatar = await form.file('avatar')
  if (!avatar) return form.error('avatar', 'No file uploaded')
  
  const dest = await avatar.move(`${__dir}/storage/avatars/${user.id}.${avatar.ext}`)
  user.avatar = dest
  return form.success('Avatar saved')
}
```

### Table Forms
For `table="..."` forms, file fields are auto-stored relative to `uploadDir` (configured in `odac.json` or `$ODAC_UPLOAD_DIR`) and the path string is persisted in the column.

### File Object Shape
```javascript
{
  field: 'avatar',
  name: 'photo.jpg',       // original filename
  ext: 'jpg',              // extension (lowercase)
  mimetype: 'image/jpeg',  // client-claimed
  size: 123456,            // bytes
  path: '/tmp/odac-...',   // temp path (null if truncated)
  truncated: false,        // true if size > maxFileSize
  stored: false,           // true after move()
  async move(dest) {...}   // move to permanent location
}
```

## Patterns
```javascript
// Custom form action in class/Contact.js
module.exports = class Contact {
  async submit(form) {
    const { email, message } = form.data;
    if (!email || !message) return form.error('email', 'Required fields missing');
    
    // Process data...
    return form.success('Message received!');
  }
}
```
