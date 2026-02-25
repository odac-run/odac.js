---
name: backend-configuration-skill
description: ODAC configuration standards for odac.json usage, environment variable mapping, and secure runtime settings.
metadata:
  tags: backend, configuration, odac-json, environment, secrets, settings
---

# Backend Configuration Skill

Managing application settings using `odac.json` and environment variables.

## Architectural Approach
ODAC uses `odac.json` for structure and `.env` for secrets. Values can be accessed via `Odac.Config` or the `Odac.env()` helper.

## Core Rules
1.  **Direct Access**: Use `Odac.Config.key` for settings in `odac.json`.
2.  **Environment Variables**: Use `${VAR_NAME}` in `odac.json` to map to `.env` values.
3.  **Encapsulation**: Never hardcode credentials. Always use `.env`.

## Reference Patterns
### 1. Accessing Config
```javascript
// From odac.json: { "app": { "name": "My App" } }
const appName = Odac.Config.app.name;

// From .env: API_KEY=secret
const apiKey = Odac.env('API_KEY');
```

### 2. odac.json Structure
```json
{
  "mysql": {
    "host": "${DB_HOST}",
    "password": "${DB_PASSWORD}"
  },
  "debug": true
}
```
