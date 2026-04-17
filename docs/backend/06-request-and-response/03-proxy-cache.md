## 🚀 Proxy Cache

`Odac.cache()` lets you tell the ODAC Proxy to cache the current page's HTML response, so repeat visitors get a near-instant response without hitting your application server at all.

> **ODAC Ecosystem Only:** This feature works exclusively within the ODAC ecosystem. It relies on the `X-ODAC-Cache` header that only the ODAC Proxy understands and acts upon.

### Basic Usage

Call `Odac.cache(seconds)` at the top of your controller with a TTL (time-to-live) in seconds:

```javascript
module.exports = function (Odac) {
  Odac.cache(3600) // Cache this page for 1 hour

  Odac.set('title', 'About Us')
  Odac.View.skeleton('main').set('content', 'about')
}
```

That's it. The ODAC Proxy handles the rest.

### How It Works

When `Odac.cache(seconds)` is called, ODAC sets two response headers:

| Header | Value | Purpose |
|--------|-------|---------|
| `X-ODAC-Cache` | `3600` | Tells the ODAC Proxy to cache this response for the given TTL |
| `Cache-Control` | `public, max-age=3600` | Standard browser/CDN cache directive |

The ODAC Proxy intercepts the response, stores it, and serves it directly on subsequent requests — bypassing your application entirely until the TTL expires.

### Smart Cache Invalidation

The ODAC Proxy is intelligent about cache invalidation. You don't need to manually clear the cache in most cases:

- **Content changes:** If the underlying page content changes (e.g. a file is updated or a deployment happens), the Proxy detects this and automatically invalidates the cache on the next request.
- **Dynamic content detection:** If the Proxy detects that a response contains dynamic or user-specific content, it cancels the cache for that response automatically.

### When to Use It

`Odac.cache()` is designed for pages where the HTML output is **identical for all visitors**:

✅ **Good candidates:**
- Marketing and landing pages
- Blog posts and articles
- Documentation pages
- Product listing pages (without personalization)
- Static "About", "Contact", "FAQ" pages

❌ **Do not use on:**
- Pages with user-specific content (dashboards, profiles, account pages)
- Pages that display session data or authentication state
- Pages with per-user pricing, recommendations, or notifications
- Any page where the HTML output differs between users

> Even though the ODAC Proxy can detect dynamic content and cancel caching, you should not rely on this as a safety net. If a page is user-specific, simply don't call `Odac.cache()`.

### TTL Reference

| Scenario | Recommended TTL |
|----------|----------------|
| Frequently updated content (news, blog) | `300` – `900` (5–15 min) |
| Semi-static content (docs, product pages) | `3600` – `86400` (1–24 hrs) |
| Fully static pages (about, landing) | `86400` – `604800` (1–7 days) |

### Error Handling

`Odac.cache()` throws a `TypeError` if the argument is not a positive integer:

```javascript
Odac.cache(3600)    // ✅ Valid
Odac.cache(0)       // ❌ TypeError
Odac.cache(-1)      // ❌ TypeError
Odac.cache('3600')  // ❌ TypeError
Odac.cache(3.5)     // ❌ TypeError
```
