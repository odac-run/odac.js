## ✉️ The `Mail` Service

The `Odac.Mail` service provides a fluent, chainable interface to send emails. **It is a zero-config service** designed to work exclusively with the **ODAC Core** server. If you are running Odac, the mail service works out of the box without any additional setup.

### How to Send an Email

The `Odac.Mail` class uses a builder pattern. You start by instantiating it with a template name, set various properties, and finally call `send()`.

#### Syntax

```javascript
await Odac.Mail('template_name')
  .from('sender@example.com', 'Sender Name')
  .to('recipient@example.com')
  .subject('Your Subject Here')
  .send({
    variable1: 'value1',
    variable2: 'value2'
  });
```

*   **Template**: The constructor takes the name of the HTML template file located in `view/mail/`.
*   **Data**: The object passed to `send()` contains key-value pairs that replace `{key}` placeholders in your HTML template.

#### Example: Contact Form Controller

Here is a complete example of how to use the Mail service inside a controller:

```javascript
module.exports = async function (Odac) {
    const { name, email, message } = Odac.Request.post;

    // 1. Validate Input
    if (!name || !email || !message) {
        return { error: 'Please fill in all fields.' };
    }

    try {
        // 2. Prepare and Send Email
        const result = await Odac.Mail('contact_form_notification')
            .from('system@myapp.com', 'My App System')
            .to('admin@myapp.com')
            .subject('New Contact Form Submission')
            .send({
                user_name: name,
                user_email: email,
                user_message: message,
                timestamp: new Date().toISOString()
            });

        // 3. Check Result
        if (result) {
            return { success: true, message: 'Thank you! We received your message.' };
        } else {
            return { error: 'Failed to send email.' };
        }

    } catch (e) {
        console.error(e);
        return { error: 'An unexpected error occurred.' };
    }
}
```

### Template File

Create your HTML template in `view/mail/contact_form_notification.html`:

```html
<h1>New Contact Message</h1>
<p><strong>From:</strong> {user_name} ({user_email})</p>
<p><strong>Time:</strong> {timestamp}</p>
<hr>
<p>{user_message}</p>
```

### Sending Plain Text or Raw HTML (No Template)

You can send emails **without creating a template file** by using the `.text()` or `.html()` methods directly. This is useful for simple notifications or dynamic content.

**Note:** If you provide both a template name AND manual content, the template will take precedence.

#### 1. Plain Text Email

Use the `.text()` method to send a simple, text-only email. The `Content-Type` will automatically be set to `text/plain`.

```javascript
await Odac.Mail() // No template name required
  .to('recipient@example.com')
  .subject('System Alert')
  .text('Server load is critical. Please check immediately.')
  .send();
```

> **Note:** Plain text does not support HTML tags like links (`<a href>`). If you write a URL (e.g., `https://odac.run`), most email clients will automatically make it clickable.

#### 2. Raw HTML Email

Use the `.html()` method to send an HTML email without a file.

```javascript
await Odac.Mail()
  .to('user@example.com')
  .subject('Welcome')
  .html('<h1>Welcome!</h1><p>Please <a href="https://example.com">click here</a>.</p>')
  .send();
```

If you use `.html()`, the system will automatically generate a plain-text version of your email by stripping the tags, just like it does for templates.

### Advanced Usage

#### Custom Headers

You can inject custom headers into the email using the `header()` method:

```javascript
.header({
    'X-Custom-Header': 'CustomValue',
    'Reply-To': 'support@example.com'
})
```

#### Chainable Methods

*   `from(email, name)`: Sets the sender.
*   `to(email)`: Sets the recipient.
*   `subject(text)`: Sets the subject line.
*   `text(content)`: Sets the plain text body (used if no template is provided).
*   `html(content)`: Sets the HTML body (used if no template is provided).
*   `header(object)`: Merges custom headers.
*   `send(data)`: Compiles the template with `data`, connects to the Odac Core, and sends the email payload. Returns a `Promise`.
