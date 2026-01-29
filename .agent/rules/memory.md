---
trigger: always_on
---

# Project Memory & Rules

## Configuration & Environment
- **Debug Mode Logic:** The `debug` configuration in `src/Config.js` defaults to `process.env.NODE_ENV !== 'production'`. This ensures that `odac dev` (undefined NODE_ENV) enables debug/hot-reload, while `odac start` (NODE_ENV=production) disables it to use caching.
- **Logging Strategy:** 
    - **Development (`debug: true`):** Enable verbose logging, hot-reloading notifications, and detailed stack traces for easier debugging.
    - **Production (`debug: false`):** Minimize logging to essential operational events (Start/Stop) and Fatal Errors only. Avoid `console.log` for per-request information to preserve performance and disk space. Sensitive error details must not be exposed to the user.

## Development Standards & Integrity
- **NO QUICK/LAZY FIXES:** Explicitly prohibited. 
    - Never implement truncated solutions (e.g., `substring(0, 32)` on a hash) or temporary workarounds just to make code run.
    - Always implement the mathematically and architecturally correct "Enterprise-Grade" solution (e.g., using raw `Buffer` for crypto keys instead of hex strings).
    - If a proper solution requires refactoring, do the refactoring. Do not patch holes.
    - **Prioritize Correctness over Speed:** It is better to verify documentation or think for a minute than to output a sub-par patch.
