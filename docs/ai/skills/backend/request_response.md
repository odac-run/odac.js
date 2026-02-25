---
name: backend-request-response-skill
description: ODAC request parsing and response composition patterns for consistent, secure, and predictable API behavior.
metadata:
  tags: backend, request, response, headers, status-codes, json, api
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
    -   `Odac.Response.header('Key', 'Value')`: Set custom headers.

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
  Odac.Response.header('Content-Type', 'text/plain');
  return "Raw text response";
};
```
