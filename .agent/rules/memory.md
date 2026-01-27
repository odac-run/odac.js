# Project Memory & Rules

## Configuration & Environment
- **Debug Mode Logic:** The `debug` configuration in `src/Config.js` defaults to `process.env.NODE_ENV !== 'production'`. This ensures that `odac dev` (undefined NODE_ENV) enables debug/hot-reload, while `odac start` (NODE_ENV=production) disables it to use caching.
