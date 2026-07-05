# Custom Forms

Odac provides an automatic form system with built-in validation, CSRF protection, and seamless client-side integration. The `<odac:form>` tag allows you to create forms with minimal code while maintaining full control.

## Basic Usage

```html
<odac:form action="Contact.submit" method="POST">
  <odac:input name="email" type="email" label="Email">
    <odac:validate rule="required|email" message="Valid email required"/>
  </odac:input>
  
  <odac:submit text="Send" loading="Sending..."/>
</odac:form>
```

## Form Attributes

### `<odac:form>`

- `action` - Controller action `Controller.method` (optional if using `table`)
- `method` - HTTP method (default: POST)
- `table` - Database table name for automatic insert (optional)
- `redirect` - Redirect URL after success (optional)
- `success` - Success message (optional)
- `class` - Additional CSS classes
- `id` - Form ID attribute
- `clear` - Set to `false` to disable auto-clearing inputs on success (optional)

```html
<!-- With custom controller action -->
<!-- Executes 'submit' method in 'contact' controller -->
<odac:form action="Contact.submit" method="POST" class="my-form" id="contact-form">
  <!-- fields here -->
</odac:form>

<!-- With automatic DB insert (no controller needed) -->
<odac:form table="waitlist" redirect="/" success="Thank you for joining!">
  <!-- fields here -->
</odac:form>
```

## Field Types

### `<odac:input>`

Supports all standard HTML input types:

```html
<!-- Text input with multiple validations -->
<odac:input name="username" type="text" label="Username" placeholder="Enter username">
  <odac:validate rule="required" message="Username is required"/>
  <odac:validate rule="minlen:3" message="Username must be at least 3 characters"/>
  <odac:validate rule="maxlen:20" message="Username cannot exceed 20 characters"/>
  <odac:validate rule="alphanumeric" message="Username can only contain letters and numbers"/>
</odac:input>

<!-- Email input -->
<odac:input name="email" type="email" label="Email Address" placeholder="your@email.com">
  <odac:validate rule="required" message="Email address is required"/>
  <odac:validate rule="email" message="Please enter a valid email address"/>
  <odac:validate rule="maxlen:100" message="Email is too long"/>
</odac:input>

<!-- Password input with strong validation -->
<odac:input name="password" type="password" label="Password">
  <odac:validate rule="required" message="Password is required"/>
  <odac:validate rule="minlen:8" message="Password must be at least 8 characters long"/>
  <odac:validate rule="maxlen:50" message="Password is too long"/>
</odac:input>

<!-- Textarea with character limits -->
<odac:input name="message" type="textarea" label="Your Message" placeholder="Tell us what you think...">
  <odac:validate rule="required" message="Please enter your message"/>
  <odac:validate rule="minlen:10" message="Message must be at least 10 characters"/>
  <odac:validate rule="maxlen:500" message="Message cannot exceed 500 characters"/>
</odac:input>

<!-- Checkbox for terms acceptance -->
<odac:input name="agree" type="checkbox" label="I agree to the Terms of Service and Privacy Policy">
  <odac:validate rule="accepted" message="You must accept the terms to continue"/>
</odac:input>

<!-- Number input with range -->
<odac:input name="age" type="number" label="Your Age">
  <odac:validate rule="required" message="Age is required"/>
  <odac:validate rule="min:18" message="You must be at least 18 years old"/>
  <odac:validate rule="max:120" message="Please enter a valid age"/>
</odac:input>

<!-- Phone number -->
<odac:input name="phone" type="text" label="Phone Number" placeholder="+1 (555) 123-4567">
  <odac:validate rule="required" message="Phone number is required"/>
  <odac:validate rule="minlen:10" message="Phone number must be at least 10 digits"/>
</odac:input>

<!-- URL input -->
<odac:input name="website" type="url" label="Website" placeholder="https://example.com">
  <odac:validate rule="url" message="Please enter a valid URL"/>
</odac:input>

<!-- Name with alpha validation -->
<odac:input name="full_name" type="text" label="Full Name" placeholder="John Doe">
  <odac:validate rule="required" message="Full name is required"/>
  <odac:validate rule="minlen:2" message="Name must be at least 2 characters"/>
  <odac:validate rule="maxlen:50" message="Name is too long"/>
</odac:input>

<!-- File upload -->
<odac:input name="avatar" type="file" label="Profile Picture">
  <odac:validate rule="required|maxsize:2MB|mimetype:image/png,image/jpeg" message="PNG or JPEG, max 2MB"/>
</odac:input>

<!-- Multiple file upload -->
<odac:input name="documents" type="file" label="Documents" multiple>
  <odac:validate rule="maxfiles:5|ext:pdf,docx" message="Max 5 PDFs or Word docs"/>
</odac:input>
```

### Field Attributes

- `name` - Field name (required)
- `type` - Input type (default: text)
- `label` - Field label
- `placeholder` - Placeholder text
- `class` - CSS classes
- `id` - Field ID

## Validation Rules

### `<odac:validate>`

Add validation rules to fields:

```html
<odac:input name="username" type="text">
  <odac:validate rule="required|minlen:3|maxlen:20" message="Username must be 3-20 characters"/>
</odac:input>
```

### Available Rules

#### Text/Input Rules
- `required` - Field is required
- `email` - Must be valid email
- `url` - Must be valid URL
- `minlen:n` - Minimum length
- `maxlen:n` - Maximum length
- `min:n` - Minimum value (numbers)
- `max:n` - Maximum value (numbers)
- `numeric` - Only numbers
- `alpha` - Only letters
- `alphanumeric` - Letters and numbers only
- `accepted` - Checkbox must be checked

#### File Upload Rules
- `required` - File must be provided
- `maxsize:2MB` - Maximum file size (supports B, KB, MB, GB)
- `minsize:10KB` - Minimum file size
- `mimetype:image/png,image/jpeg` - Allowed MIME types (comma-separated; wildcards like `image/*` supported)
- `accept:...` - Alias for `mimetype:`
- `ext:jpg,png` - Allowed file extensions (case-insensitive)
- `maxfiles:5` - Maximum number of files for `multiple` uploads

### Multiple Rules

Combine rules with `|`:

```html
<odac:validate rule="required|email|maxlen:100" message="Invalid email"/>
```

### Unique Validation

For automatic DB insert, use `unique` to check if value already exists:

```html
<odac:validate rule="required|email|unique" message="This email is already registered"/>
```

## Auto-Set Values

### `<odac:set>`

Automatically set field values without user input:

```html
<odac:set name="created_at" compute="now"/>
<odac:set name="ip" compute="ip"/>
<odac:set name="user_agent" compute="user_agent"/>
<odac:set name="status" value="pending"/>
```

### Available Compute Types

- `now` - Current Unix timestamp (seconds)
- `date` - Current date (YYYY-MM-DD)
- `datetime` - Current ISO datetime
- `timestamp` - Current timestamp (milliseconds)
- `ip` - User's IP address
- `user_agent` - User's browser user agent
- `uuid` - Generate UUID v4

### Set Attributes

- `name` - Field name (required)
- `value` - Static value
- `compute` - Computed value type
- `callback` - Custom function name
- `if-empty` - Only set if field is empty

## Submit Button

### `<odac:submit>`

```html
<!-- Simple -->
<odac:submit text="Submit"/>

<!-- With loading state -->
<odac:submit text="Send Message" loading="Sending..."/>

<!-- With styling -->
<odac:submit text="Save" loading="Saving..." class="btn btn-primary" id="save-btn"/>
```

## Client-Side Callbacks (Optional)

`<odac:form>` works fully on its own — submission, CSRF, validation, loading
states, success/error messages and redirects are all wired up automatically,
**no JavaScript required.**

If you also need to run your own code after a submit (analytics, closing a
modal, updating the UI, etc.), give the form an `id` and attach a callback with
`Odac.form()`:

```html
<odac:form action="Account.unlink" id="server-unlink">
  <!-- fields -->
  <odac:submit text="Unlink"/>
</odac:form>
```

```javascript
Odac.form('#server-unlink', function(data) {
  if (data.result.success) {
    closeModal()
  }
})
```

This is **safe to combine** with the automatic registration — calling
`Odac.form()` on an `<odac:form>` re-binds the same form rather than adding a
second handler, so the form still submits only once. (Internally the dedup is
keyed by the form element, not the selector string.)

> **Note:** Call `Odac.form()` after the form exists in the DOM (e.g. on
> `DOMContentLoaded` or after AJAX navigation). Binding before the element is
> rendered can leave the automatic registration in place as a second handler.

You can trigger submission programmatically with the native API:

```javascript
document.getElementById('server-unlink').requestSubmit()
```

For the full callback/options API (`messages`, `loading`, redirect strings,
file-upload progress) see
[Form Handling with odac.js](../../frontend/03-forms/01-form-handling.md).

## Controller Handler (Server Actions)
 
Handle form submission directly in your controller. The action is defined as `ControllerName.methodName`.

**View:**
```html
<odac:form action="Contact.submit">
    ...
</odac:form>
```

**Controller (controller/Contact.js):**

```javascript
module.exports = class Contact {
  constructor(Odac) {
    this.Odac = Odac
  }

  async submit(form) {
    // 1. Access validated clean data
    const { email, message } = form.data

    // 2. Perform your logic
    // await this.Odac.Mail().send(email, message)

    // 3. Return success easily
    return form.success('Message sent successfully!', '/thank-you')
  }
}
```

### Error Handling

Return errors using the helper method:

```javascript
module.exports = class Contact {
  constructor(Odac) {
    this.Odac = Odac
  }

  async submit(form) {
    const { email } = form.data
    
    // Custom backend validation
    if (email.includes('spam')) {
      // Returns field-specific error
      return form.error('email', 'Spam is not allowed!')
    }
    
    return form.success('Success!')
  }
}
```

**Note:** No route definition is needed for the action! The form system handles the routing securely.

## File Upload Handling

Access uploaded files in your controller via `form.file(name)`:

```javascript
module.exports = class Profile {
  constructor(Odac) {
    this.Odac = Odac
  }

  async updateAvatar(form) {
    const avatar = await form.file('avatar')
    if (!avatar) {
      return form.error('avatar', 'No file uploaded')
    }

    // Store the file permanently
    const userId = this.Odac.Auth.user('id')
    const dest = await avatar.move(`${__dir}/../storage/avatars/${userId}.${avatar.ext}`)
    
    // Update user record with file path
    // await this.Odac.DB.users.where('id', userId).update({avatar: dest})
    
    return form.success('Avatar updated!', '/profile')
  }
}
```

For `table="..."` forms with file fields, files are automatically stored in the configured `uploadDir` and the file path is saved to the database column.

> **Security:** `move(dest)` writes to whatever path you pass, just like `fs` — the file object's own `.name` is already stripped to a bare filename, but if you build `dest` from raw user input, sanitize it yourself to avoid path traversal. Server-generated names (as in the example above) are always safe. Uploads are validated for size/type before your handler runs, but content sniffing only covers raster images (JPEG/PNG/GIF/WebP); other types are trusted by extension + declared MIME, and `image/*` also permits SVG (an XSS vector) — list explicit types like `mimetype:image/png,image/jpeg` when you need to exclude it.

## Automatic Database Insert

Forms can automatically insert data into database without writing a controller:

### View (view/content/waitlist.html)

```html
<odac:form table="waitlist" redirect="/" success="Thank you for joining!">
  <odac:input name="email" type="email" label="Email">
    <odac:validate rule="required|email|unique" message="Valid email required"/>
  </odac:input>
  
  <odac:input name="name" type="text" label="Name">
    <odac:validate rule="required|minlen:2" message="Name required"/>
  </odac:input>
  
  <odac:set name="created_at" compute="now"/>
  <odac:set name="ip" compute="ip"/>
  
  <odac:submit text="Join Waitlist" loading="Joining..."/>
</odac:form>
```

### Database Table

```sql
CREATE TABLE `waitlist` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `email` VARCHAR(255) NOT NULL UNIQUE,
  `name` VARCHAR(255) NOT NULL,
  `created_at` INT UNSIGNED NOT NULL,
  `ip` VARCHAR(45) NULL,
  INDEX `idx_email` (`email`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

### Route (route/www.js)

```javascript
Odac.Route.page('/waitlist', 'waitlist')
```

That's it! No controller needed. The form will:
- Validate all fields
- Check email uniqueness
- Insert data into `waitlist` table
- Show success message
- Redirect to home page

## Complete Example with Custom Controller

### View (view/content/contact.html)

```html
<div class="contact-page">
  <h1>Contact Us</h1>
  
  <odac:form action="Contact.submit" method="POST" class="contact-form">
    <odac:input name="name" type="text" label="Your Name" placeholder="Enter your name">
      <odac:validate rule="required|minlen:3" message="Name must be at least 3 characters"/>
    </odac:input>
    
    <odac:input name="email" type="email" label="Email" placeholder="your@email.com">
      <odac:validate rule="required|email" message="Please enter a valid email"/>
    </odac:input>
    
    <odac:input name="subject" type="text" label="Subject" placeholder="What is this about?">
      <odac:validate rule="required|minlen:5" message="Subject must be at least 5 characters"/>
    </odac:input>
    
    <odac:input name="message" type="textarea" label="Message" placeholder="Your message...">
      <odac:validate rule="required|minlen:10" message="Message must be at least 10 characters"/>
    </odac:input>
    
    <odac:submit text="Send Message" loading="Sending..." class="btn btn-primary"/>
  </odac:form>
</div>
```

### Controller (controller/contact.js)

```javascript
module.exports = class Contact {
  constructor(Odac) {
    this.Odac = Odac
  }

  async index() {
    this.Odac.View.skeleton('default')
    this.Odac.View.set({content: 'contact'})
    this.Odac.View.print()
  }

  async submit(form) {
    // Get validated data from form helper
    const { name, email, subject, message } = form.data
    
    // Save to database
    // Save to database
    // await this.Odac.DB.contacts.insert({ name, email, subject, message })
    
    // Send email notification
    // await this.Odac.Mail().to('admin@example.com').subject('New Contact').send(message)
    
    return form.success('Thank you! We will get back to you soon.', '/')
  }
}
```

### Route (route/www.js)

```javascript
Odac.Route.page('/contact', 'contact')
// Note: No route needed for contact.submit action!
```

## Features

- **Automatic CSRF Protection** - Built-in token validation
- **Client-Side Validation** - HTML5 validation with custom messages
- **Server-Side Validation** - Automatic validation before controller execution
- **Session Security** - Form tokens tied to user session, IP, and user agent
- **Loading States** - Automatic button state management
- **Error Display** - Automatic error message rendering
- **Success Messages** - Built-in success message handling
- **Auto-Clear** - Clears inputs on success (disable with `clear="false"`)
- **Redirect Support** - Optional redirect after successful submission

## Security

Forms automatically include:

- CSRF token validation
- Session verification
- IP address validation
- User agent verification
- Token expiration (30 minutes)

All validation happens before your controller is executed, ensuring only valid, secure data reaches your code.
