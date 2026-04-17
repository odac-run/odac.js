---
name: backend-request-response-skill
description: ODAC request parsing and response composition patterns for consistent, secure, and predictable API behavior.
metadata:
  tags: backend, request, response, headers, status-codes, json, api, cache, proxy
---

# Backend Request & Response Skill

Handling incoming data and sending structured responses.

## Core Rules
1.  **Request Data**: 
    -   `Odac.request('key')`: Auto-detect GET/POST (Recommended).
    -   `Odac.Request.post('key')`: Targeted POST data.
    -   `Odac.Request.get('key')`: Targeted URL parameters.
2.  **Metadata**: Access `Odac.Request.method`, `Odac.Request.ip`, `Odac.Request.header('name')`.
3.  **Returning Data**: 
    -   `return { ... }`: Returns JSON.
    -   `return Odac.return({ ... })`: Explicit JSON return.
    -   `Odac.Request.header('Key', 'Value')`: Set custom headers.

## Reference Patterns
### 1. Unified Request Handling
```javascript
module.exports = async function(Odac) {
  const name = await Odac.request('name');
  const method = Odac.Request.method;
  
  if (method === 'POST') {
    return { success: true, message: `Saved ${name}` };
  }
};
```

### 2. Header and Status Management
```javascript
module.exports = function(Odac) {
  Odac.Request.header('Content-Type', 'text/plain');
  return "Raw text response";
};
```

### 3. Proxy Cache Control
Enable ODAC Proxy caching for static or semi-static page responses. Sets `X-ODAC-Cache` and `Cache-Control` headers automatically.

**ODAC Ecosystem Only** — requires the ODAC Proxy. Has no effect in standalone deployments.

```javascript
module.exports = function(Odac) {
  Odac.cache(3600) // Cache for 1 hour
  Odac.View.skeleton('main').set('content', 'about')
}
```

**Rules:**
- `Odac.cache(seconds)` — positive integer only. Throws `TypeError` otherwise.
- Overrides any previously set `Cache-Control` header for the request.
- **ODAC Proxy is smart:** automatically invalidates cache when content changes or dynamic content is detected.
- **Despite smart invalidation, never use on:** user-specific pages (dashboards, profiles, account pages), pages with session data, auth state, or per-user content. Do not rely on auto-detection as a safety net.

**Good candidates:** marketing pages, blog posts, docs, product listings (no personalization), static pages (about, FAQ, contact).
