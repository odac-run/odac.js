# Form Handling with odac.js

Learn how to handle forms with automatic AJAX submission, CSRF protection, and validation in Odac.

## Quick Start

### Basic Form

```html
<form id="contact-form" action="/api/contact" method="POST">
  <input name="email" type="email" required>
  <button type="submit">Submit</button>
</form>
```

```javascript
Odac.form('#contact-form', function(data) {
  if (data.result.success) {
    alert('Form submitted successfully!')
  }
})
```

That's it! odac.js handles:
- ✅ AJAX submission
- ✅ CSRF token (automatic)
- ✅ Validation errors (auto-generated)
- ✅ Success messages (auto-generated)
- ✅ Loading states

**Note:** Error and success message elements are automatically created if not present in your HTML. You can optionally add them for custom styling or positioning.

## Form Configuration

### Basic Usage

```javascript
Odac.form('#my-form', function(data) {
  console.log('Response:', data)
})
```

### With Options

```javascript
Odac.form({
  form: '#my-form',
  messages: true,  // Show error/success messages
  loading: function(percent) {
    console.log('Upload progress:', percent + '%')
  }
}, function(data) {
  if (data.result.success) {
    console.log('Success!')
  }
})
```

### Redirect After Submit

```javascript
Odac.form('#my-form', '/success-page')
// Redirects to /success-page on success
```

## Using with `<odac:form>` Components

`Odac.form()` works with both plain `<form>` elements and server-rendered
[`<odac:form>` components](../../backend/05-forms/01-custom-forms.md).

An `<odac:form>` already registers itself automatically, so you only call
`Odac.form()` when you want to add your own callback. Give the component an `id`
and bind to it:

```html
<odac:form action="Contact.submit" id="contact-form">
  <!-- fields -->
  <odac:submit text="Send"/>
</odac:form>
```

```javascript
Odac.form('#contact-form', function(data) {
  if (data.result.success) {
    closeModal()
  }
})
```

Calling `Odac.form()` on an already-registered `<odac:form>` **re-binds** the
same form instead of adding a second handler, so it still submits only once.

## Error Handling

### Automatic Error Display

By default, errors are automatically displayed next to the input fields when validation fails. The system creates error elements automatically.

### Custom Error Placement (Optional)

If you want to control where errors appear, add error elements manually:

```html
<input name="email" type="email">
<span odac-form-error="email"></span>
```

**If not present:** The system automatically creates `<span odac-form-error="email">` after the input field.

**If present:** The system uses your existing element and updates its content.

### Custom Error Display

```javascript
Odac.form('#my-form', function(data) {
  if (!data.result.success) {
    // Custom error handling
    Object.entries(data.errors).forEach(([field, message]) => {
      console.log(`${field}: ${message}`)
    })
  }
})
```

### Styling Errors

```css
/* Error message */
[odac-form-error] {
  color: #ef4444;
  font-size: 0.875rem;
  margin-top: 0.25rem;
  display: none;
}

/* Invalid input */
input._odac_error {
  border-color: #ef4444;
}
```

## Success Messages

### Automatic Success Display

Success messages are automatically displayed at the end of the form when submission succeeds.

### Custom Success Placement (Optional)

If you want to control where success messages appear, add a success element manually:

```html
<form id="my-form" action="/api/submit" method="POST">
  <!-- form fields -->
  <button type="submit">Submit</button>
  <div odac-form-success></div>
</form>
```

**If not present:** The system automatically creates `<span odac-form-success>` at the end of the form.

**If present:** The system uses your existing element and updates its content.

### Custom Success Message

```javascript
Odac.form('#my-form', function(data) {
  if (data.result.success) {
    document.querySelector('#custom-message').innerHTML = 
      'Thank you! Your form has been submitted.'
  }
})
```

## File Uploads

### Basic File Upload with `<odac:form>`

File upload in Odac forms is seamless — just add a `type="file"` input and validation rules:

```html
<odac:form action="Profile.saveAvatar" id="avatar-form">
  <odac:input type="file" name="avatar" label="Profile Picture">
    <odac:validate rule="required|maxsize:2MB|mimetype:image/png,image/jpeg" message="PNG/JPEG, max 2MB"/>
  </odac:input>
  <odac:submit text="Upload"/>
</odac:form>
```

```javascript
Odac.form('#avatar-form', function(data) {
  if (data.result.success) {
    alert('Avatar uploaded!')
  }
})
```

**Features:**
- ✅ Client-side validation (size, MIME type, extension)
- ✅ Server-side validation with magic-byte sniffing for images
- ✅ Automatic multipart/form-data handling
- ✅ File size progress tracking

### Upload Progress Tracking

```javascript
Odac.form({
  form: '#avatar-form',
  loading: function(percent) {
    document.querySelector('#progress').style.width = percent + '%'
  }
}, function(data) {
  if (data.result.success) {
    console.log('Upload complete!')
  }
})
```

### Multiple File Upload

For multiple file selection, add the `multiple` attribute and use `maxfiles` validation:

```html
<odac:input type="file" name="documents" label="Documents" multiple>
  <odac:validate rule="maxfiles:5|ext:pdf,docx" message="Max 5 PDFs/Word docs"/>
</odac:input>
```

**Note:** File inputs are never repopulated on validation error (for security). Users must re-select files after an error.

## Advanced Features

### Disable Messages

```javascript
Odac.form({
  form: '#my-form',
  messages: false  // Don't show automatic messages
}, function(data) {
  // Handle messages manually
})
```

### Disable Specific Messages

```javascript
// Only show error messages, suppress success messages
Odac.form({
  form: '#my-form',
  messages: ['error']
}, function(data) {
  if (data.result.success) {
    // Custom success handling
  }
})

// Only show success messages, suppress error messages
Odac.form({
  form: '#my-form',
  messages: ['success']
}, function(data) {
  if (!data.result.success) {
    // Custom error handling
  }
})
```

### Form Reset

```javascript
Odac.form('#my-form', function(data) {
  if (data.result.success) {
    // Reset the form
    document.querySelector('#my-form').reset()
  }
})
```

### Conditional Submission

```javascript
document.querySelector('#my-form').addEventListener('submit', function(e) {
  if (!confirm('Are you sure?')) {
    e.preventDefault()
    e.stopPropagation()
  }
})

Odac.form('#my-form', function(data) {
  console.log('Submitted!')
})
```

## Server-Side Setup

### Controller Example

```javascript
// controller/post/contact.js
module.exports = async function(Odac) {
  const email = await Odac.Request.request('email')
  const message = await Odac.Request.request('message')
  
  // Validation
  const errors = {}
  if (!email) errors.email = 'Email is required'
  if (!message) errors.message = 'Message is required'
  
  if (Object.keys(errors).length > 0) {
    return {
      result: {success: false},
      errors: errors
    }
  }
  
  // Process form
  // ... send email, save to database, etc.
  
  return {
    result: {
      success: true,
      message: 'Thank you for your message!'
    }
  }
}
```

### Route Setup

```javascript
// route/www.js
Odac.Route.post('/api/contact', 'contact')
```

## Validation

### Client-Side Validation

Use HTML5 validation:

```html
<input name="email" type="email" required>
<input name="age" type="number" min="18" max="100">
<input name="website" type="url">
```

### Server-Side Validation

Always validate on the server:

```javascript
module.exports = async function(Odac) {
  const email = await Odac.Request.request('email')
  
  const errors = {}
  
  // Required field
  if (!email) {
    errors.email = 'Email is required'
  }
  
  // Email format
  else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    errors.email = 'Invalid email format'
  }
  
  // Check if exists
  else if (await emailExists(email)) {
    errors.email = 'Email already registered'
  }
  
  if (Object.keys(errors).length > 0) {
    return {result: {success: false}, errors}
  }
  
  // Process...
}
```

## Common Patterns

### Contact Form

```html
<form id="contact-form" action="/api/contact" method="POST">
  <input name="name" type="text" required>
  <input name="email" type="email" required>
  <textarea name="message" required></textarea>
  <button type="submit">Send Message</button>
</form>
```

**Note:** Error and success elements are auto-generated. Add them manually only if you need custom positioning or styling.

```javascript
Odac.form('#contact-form', function(data) {
  if (data.result.success) {
    document.querySelector('#contact-form').reset()
  }
})
```

### Login Form

```html
<form id="login-form" action="/api/login" method="POST">
  <input name="email" type="email" required>
  <input name="password" type="password" required>
  <button type="submit">Login</button>
</form>
```

```javascript
Odac.form('#login-form', function(data) {
  if (data.result.success) {
    // Redirect to dashboard
    window.location.href = '/dashboard'
  }
})
```

### Registration Form

```html
<form id="register-form" action="/api/register" method="POST">
  <input name="name" type="text" required>
  <input name="email" type="email" required>
  <input name="password" type="password" required minlength="8">
  <input name="password_confirm" type="password" required>
  <button type="submit">Register</button>
</form>
```

**Tip:** For better UX, you can add custom error elements for specific positioning:

```html
<div class="form-group">
  <input name="email" type="email" required>
  <span odac-form-error="email" class="error-message"></span>
</div>
```

## Best Practices

1. **Always Validate Server-Side**: Never trust client-side validation alone
2. **Show Clear Errors**: Display errors next to the relevant fields
3. **Provide Feedback**: Show loading states during submission
4. **Reset on Success**: Clear the form after successful submission
5. **Handle Errors Gracefully**: Provide helpful error messages
6. **Use HTTPS**: Always use HTTPS for forms with sensitive data

## Troubleshooting

### Form Not Submitting

- Check that `Odac.form()` is called after DOM is ready
- Verify the form selector is correct
- Check browser console for errors

### Errors Not Displaying

- Errors are automatically created - no manual elements needed
- Check that server returns errors in correct format: `{result: {success: false}, errors: {fieldName: 'message'}}`
- Verify `messages` option is not set to `false`
- If using custom error elements, ensure `odac-form-error` attributes match field names exactly

### Form Submits Twice

- Make sure you don't register the **same form under two different selectors**
  (e.g. `Odac.form('#my-form')` and `Odac.form('form#my-form')`) — use one
  consistent selector.
- Binding `Odac.form()` to an `<odac:form>` is safe and will **not** double up;
  it re-binds the existing handler. If you still see two submits, check that you
  bind **after** the form is in the DOM, not before it renders.

### CSRF Token Errors

- CSRF tokens are handled automatically
- If you get token errors, check server configuration
- Ensure cookies are enabled

## Next Steps

- Learn about [Validation](02-validation.md)
- Explore [File Uploads](03-file-uploads.md)
- Check [API Requests](../04-api-requests/01-get-post.md)
