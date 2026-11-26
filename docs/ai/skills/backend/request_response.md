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
    -   `Odac.rawBody(encoding?)`: Async raw request body (`Buffer` by default, or decoded `string` when a valid `BufferEncoding` like `'utf8'` is passed). Use this for webhook HMAC signature verification (Stripe, GitHub, etc.) or non-JSON payloads — never re-serialize `await Odac.request()` or try to read `Odac.Request.req` manually (the stream is already consumed before controllers run). Returns `null` for `multipart/form-data`, oversized `413` bodies, or after response end.
    -   `Odac.Request.post('key')`: Targeted POST data.
    -   `Odac.Request.get('key')`: Targeted URL parameters.
2.  **Metadata**: Access `Odac.Request.method`, `Odac.Request.ip`, `Odac.Request.header('name')`.
    -   `Odac.Request.ip` / `Odac.Request.ssl` come from the ODAC Proxy's `X-Odac-Connection-*` headers only when they provably come from the proxy: a connection on the proxy unix socket (`ODAC_PROXY_SOCKET`), a valid `X-Odac-Connection-Signature` (HMAC with `ODAC_PROXY_KEY`, set by the server), or a TCP peer listed in `request.trustedProxies`. With a key and no list, unsigned TCP requests are never trusted, even from private addresses. Without a key (older server, app not restarted since the update) an app under ODAC (`ODAC_APP=true`) trusts loopback + private networks and any other app trusts nobody. Never read `req.socket.remoteAddress` or the raw headers yourself, and never verify the signature by hand. Behind your own reverse proxy (nginx, a load balancer), list it in `request.trustedProxies` and make it overwrite `X-Odac-Connection-RemoteAddress`; otherwise every visitor has the proxy's IP and IP-keyed limits lock everyone out together (ODAC logs a WARN once per worker when it sees forwarding headers from an untrusted loopback/private peer). `X-Forwarded-For` is never read.
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

### 3. Raw Body & Webhook HMAC Verification
```javascript
const crypto = require('crypto')

module.exports = async function (Odac) {
  const raw = await Odac.rawBody() // Buffer (exact wire bytes)
  const sig = Odac.Request.header('x-hub-signature-256') || ''
  const expected = 'sha256=' + crypto.createHmac('sha256', Odac.env('WEBHOOK_SECRET')).update(raw).digest('hex')

  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
    return Odac.abort(401)
  }

  const payload = await Odac.request() // Parsed JSON still available
  return {ok: true, event: payload.event}
}
```

### 4. Proxy Cache Control
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
- **Multilingual pages:** a language picked from `Accept-Language` sends `Vary: Accept-Language` and the proxy does not cache it. Cache per-language URLs (`/{lang}/...` + `Odac.Lang.set()`) instead.
- **Despite smart invalidation, never use on:** user-specific pages (dashboards, profiles, account pages), pages with session data, auth state, or per-user content. Do not rely on auto-detection as a safety net.

**Good candidates:** marketing pages, blog posts, docs, product listings (no personalization), static pages (about, FAQ, contact).
