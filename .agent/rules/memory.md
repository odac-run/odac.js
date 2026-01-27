# Project Memory & Rules

## Configuration & Environment
- **Debug Mode Logic:** The `debug` configuration in `src/Config.js` defaults to `process.env.NODE_ENV !== 'production'`. This ensures that `odac dev` (undefined NODE_ENV) enables debug/hot-reload, while `odac start` (NODE_ENV=production) disables it to use caching.
- **Logging Strategy:** 
    - **Development (`debug: true`):** Enable verbose logging, hot-reloading notifications, and detailed stack traces for easier debugging.
    - **Production (`debug: false`):** Minimize logging to essential operational events (Start/Stop) and Fatal Errors only. Avoid `console.log` for per-request information to preserve performance and disk space. Sensitive error details must not be exposed to the user.
