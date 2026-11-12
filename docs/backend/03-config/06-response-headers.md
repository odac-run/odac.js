## 🛡️ Default Response Headers

Every response starts with these headers:

| Header | Default |
| --- | --- |
| `X-Content-Type-Options` | `nosniff` |
| `X-Frame-Options` | `SAMEORIGIN` |
| `Referrer-Policy` | `strict-origin-when-cross-origin` |

They match what the ODAC proxy adds, so the app is protected the same way when it is reached directly or through another proxy. `Strict-Transport-Security` is not sent by the app: TLS ends at the proxy, which sets it.

Change or drop a default in `odac.json` (`false` or `null` removes it):

```json
"headers": {
  "X-Frame-Options": "DENY",
  "Referrer-Policy": false
}
```

A single response can still override any of them, in any casing:

```javascript
Odac.Request.header('X-Frame-Options', null) // allow framing for this response
```

HTML pages are sent as `text/html; charset=utf-8`.
