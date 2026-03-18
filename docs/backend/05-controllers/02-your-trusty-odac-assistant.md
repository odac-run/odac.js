## 🤝 Your trusty `Odac` Assistant

Remember the `Odac` object? It's your best friend inside a controller. It's passed to your controller function and gives you all the tools you need for the current request.

#### Awesome Services at Your Fingertips

*   `Odac.Request`: Info about the user's request.
*   `Odac.View`: Renders your HTML pages.
*   `Odac.Auth`: Manages user logins.
*   `Odac.Token`: Protects your forms.
*   `Odac.Lang`: Helps with different languages.

#### Handy Helper Functions

*   `Odac.return(data)`: Send back a response.
*   `Odac.direct(url)`: Redirect the user to a new page.
*   `Odac.set(key, value)`: Pass variables to your View template.
*   `Odac.share(key, value)`: Share data directly with frontend JavaScript (`odac.data()`).
*   `Odac.cookie(key, value)`: Set a browser cookie.
*   `Odac.validator()`: Check user input easily.
*   `Odac.setInterval(callback, delay)`: Schedule repeating tasks (auto-cleanup).
*   `Odac.setTimeout(callback, delay)`: Schedule one-time tasks (auto-cleanup).
*   `Odac.stream(input)`: Create streaming responses (SSE).
*   `Odac.image(src, options)`: Get a processed image URL (resize, format conversion, caching).

#### Memory-Safe Timers

Always use `Odac.setInterval()` and `Odac.setTimeout()` instead of global functions:

```javascript
module.exports = async (Odac) => {
  // ✅ Good - automatically cleaned up
  Odac.setInterval(() => {
    // This stops when request ends
  }, 1000)
  
  // ❌ Bad - memory leak!
  setInterval(() => {
    // This runs forever
  }, 1000)
}
```

With controllers and the `Odac` object, you have everything you need to start building powerful application logic!

#### Image Processing

Use `Odac.image()` when you need a processed image URL outside of templates — for JSON APIs, div backgrounds, email templates, or cron jobs:

```javascript
module.exports = async (Odac) => {
  // Get a resized WebP URL for an API response
  const heroUrl = await Odac.image('/images/hero.jpg', { width: 1200 })
  // → "/_odac/img/hero-1200-a1b2c3d4.webp"

  // Pass a processed URL to the template for a CSS background
  const bgUrl = await Odac.image('/images/banner.jpg', { width: 1920, quality: 90 })
  Odac.set('bgUrl', bgUrl)

  // Convert to a specific format
  const pngLogo = await Odac.image('/images/logo.png', { width: 200, format: 'png' })
}
```

**Options:** `{ width, height, format, quality }` — same as `<odac:img>` tag attributes.

> When `sharp` is not installed, `Odac.image()` returns the original source path as a graceful fallback. For template usage with automatic `<img>` tag generation, see the [`<odac:img>` documentation](../07-views/11-image-optimization.md).
