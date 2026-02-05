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

## Code Quality & Modern Standards
- **No Legacy Syntax:** 
    - **Strictly Prohibited:** The use of `var` is forbidden. Use `const` (preferred) or `let` (only if mutation is needed).
    - **Variable Scope:** Ensure variables are block-scoped to prevent leakage.
- **Anti-Spaghetti Code:**
    - **Fail-Fast Pattern:** Avoid deeply nested `if/else` logic. Use early returns (`return`, `break`, `continue`) to handle negative cases immediately.
    - **Promise Handling:** Resolve Promises upfront (e.g., `Promise.all` or strict `await` before loops) rather than mixing `await` inside deep logic or mutating input objects.
    - **Strict Equality:** Always use strict equality checks (`===`) instead of loose ones.
    - **Loop Optimization:** Use labeled loops (`label: for`) for efficient control flow in nested structures. Eliminate intermediate "flag" variables (`isMatch`, `found`) by using direct `return` or `continue label`.
    - **Direct Returns:** Return a value as soon as it is determined. Avoid assigning to a temporary variable (e.g. `matchedUser`) and breaking the loop, unless post-loop processing is strictly necessary.
    - **Async State Safety:** When an async function depends on mutable class state (like `pendingMiddlewares`), capture that state into a local `const` *synchronously* before triggering any async operations. This prevents race conditions where the state changes before the async task consumes it.

## Dependency Management
- **Prefer Native Fetch:** Use the native `fetch` API for network requests in both Node.js (18+) and browser environments to reduce dependencies and bundle size.