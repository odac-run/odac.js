---
inclusion: always
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
    - **Async I/O Preference:** Prefer asynchronous file system operations (`fs.promises` or `await fs.promises.*`) over synchronous methods (`fs.readFileSync`, `fs.writeFileSync`) to prevent blocking the event loop and ensure high concurrency, especially in request handling paths.

## Dependency Management
- **Prefer Native Fetch:** Use the native `fetch` API for network requests in both Node.js (18+) and browser environments to reduce dependencies and bundle size.

## Naming & Text Conventions
- **ODAC Casing:** Always write "ODAC" in uppercase letters when referring to the framework name in strings, comments, log messages, or user-facing text. **EXCEPTION:** The class name itself (`class Odac`) and variable references to it should remain `Odac` (PascalCase) as per code conventions.

## Documentation Standards
- **AI Skill Front Matter:** Every file under `docs/ai/skills/**/*.md` must start with YAML front matter containing `name`, `description`, and `metadata.tags`; values must be specific to that document's topic (never copied from generic examples).

## Testing & Validation
- **Mandatory Test Coverage:** Every new feature, method, or significant logic change MUST be accompanied by a corresponding unit or integration test.
    - **Verify Correctness:** do not assume code works; prove it with a test that covers both success and failure scenarios (e.g., edge cases, error conditions).
    - **Update Existing Tests:** If a feature modifies existing behavior, update the relevant tests to reflect the new logic and ensure they pass.
- **Atomic Test Structure:**
    - **Directory Mapping:** Each source class/module must have its own directory under `test/` (e.g., `src/Auth.js` -> `test/Auth/`).
    - **Method-Level Files:** Every public method should have its own test file within the class directory (e.g., `test/Auth/check.test.js`).
    - **Sub-module Context:** Nested modules should follow the same pattern (e.g., `src/View/Form.js` -> `test/View/Form/generateFieldHtml.test.js`).
    - **Isolation & Parallelism:** This structure is mandatory to leverage Jest's multi-threaded execution and ensure strict isolation between test cases.

## Client Library (odac.js)
- **Automatic JSON Parsing:** The `#ajax` method (and by extension `odac.get`) must automatically parse the response if the `Content-Type` header contains `application/json`, even if `dataType` is not explicitly set to `json`.

## Security Logic & Authentication
- **Enterprise Token Rotation:** The `Auth.js` system utilizes a non-blocking refresh token rotation mechanism for cookies (`odac_x`/`odac_y`). To prevent race conditions during concurrent requests in high-throughput SPAs, rotated tokens are **not** immediately deleted. Instead, their `active` timestamp is set to naturally expire in 60 seconds (Grace Period), and their `date` timestamp is set to the Unix Epoch (`new Date(0)`) as an identifier mark. Never delete rotated tokens immediately.