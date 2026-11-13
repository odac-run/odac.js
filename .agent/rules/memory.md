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
    - **Async I/O Preference:** Prefer asynchronous file system operations (`fs.promises` or `await fs.promises.*`) over synchronous methods (`fs.readFileSync`, `fs.writeFileSync`) to prevent blocking the event loop and ensure high concurrency, especially in request handling paths.

## Dependency Management
- **Prefer Native Fetch:** Use the native `fetch` API for network requests in both Node.js (18+) and browser environments to reduce dependencies and bundle size.
- **Hybrid Overrides:** When using `overrides` in `package.json` for security hardening, always verify tool compatibility (especially Jest/Coverage). If a global override (e.g., `minimatch: 10.x`) breaks a critical utility (e.g., `test-exclude`), use a nested override to provide a compatible version (e.g., `3.x`) for that specific tool while keeping the rest of the project secure.

## Naming & Text Conventions
- **ODAC Casing:** Always write "ODAC" in uppercase letters when referring to the framework name in strings, comments, log messages, or user-facing text. **EXCEPTION:** The class name itself (`class Odac`) and variable references to it should remain `Odac` (PascalCase) as per code conventions.

## Documentation Standards
- **AI Skill Front Matter:** Every file under `docs/ai/skills/**/*.md` must start with YAML front matter containing `name`, `description`, and `metadata.tags`; values must be specific to that document's topic (never copied from generic examples).
- **Template Syntax Documentation:** `{{ }}` and `<odac var>` are equal-status syntaxes, NOT legacy vs modern. `{{ }}` is preferred inside HTML attributes and inline text; `<odac var>` is preferred for standalone block output. Never label `{{ }}` as "legacy" or "backward compatibility" in docs.

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
- **Template String Escaping:** When escaping template strings for inline JavaScript execution or translation payloads, always escape backslashes first before escaping single quotes (e.g., `.replace(/\\/g, '\\\\').replace(/'/g, "\\'")`) to prevent an injected backslash from disabling the quote escape and causing a Template Injection / XSS vulnerability.

## View Engine & SSR
- **Auto-Navigation Injection:** The ODAC View engine (`src/View.js`) automatically parses skeleton HTML files and dynamically injects `data-odac-navigate` attributes into ALL elements wrapping `{{ PART_NAME }}` placeholders (e.g. `{{ CONTENT }}`, `{{ SIDEBAR }}`, `{{ FOOTER }}`). Do NOT manually add these attributes to HTML templates.
- **Smart Part Diffing (AJAX Navigation):** The AJAX navigation system uses a server-driven part diffing mechanism. The client sends its current part values via `X-Odac-Parts` header (e.g. `content=docs/intro,sidebar=docs/nav`). The server compares these with the new page's parts and only renders/returns parts whose view path has changed. Parts that are identical between pages are skipped (no re-render, no DOM update). Parts that exist on the old page but not the new page are cleared. The `parts` manifest is included in every AJAX response for the client to track state. **Exception:** The `content` part is always re-rendered regardless of view path match, since its output is URL-dependent.
- **Part Refresh Override:** `View.set('partName', 'viewPath', { refresh: true })` forces a part to re-render on every AJAX navigation even if its view path hasn't changed. Useful for parts with request-dependent dynamic content (e.g. active menu state). The `#refresh` Set tracks which parts bypass the diffing comparison.
- **Initial Parts State:** On first page load, the `<html>` tag receives a `data-odac-parts` JSON attribute containing the current part-to-view mapping. The client reads this to initialize its parts tracking state for subsequent AJAX navigations.
## Server & ODAC Proxy Socket
- **Proxy Socket Ownership:** When `ODAC_PROXY_SOCKET` is set, `src/Server/ProxySocket.js` serves the app on that unix path next to the TCP port. In the cluster the primary owns every listening handle, so only the primary clears a stale file (before forking) and removes it at shutdown (identity-checked by dev/ino). Workers never unlink the path: a draining or crashed worker would delete the socket its siblings serve. Workers learn the decision through the fork env (resolved path, or empty for TCP only).
- **Proxy Socket Trust:** A connection on the proxy socket is trusted because of the listener that accepted it (`markProxySocket` on the socket server's `connection` event, read by `isProxySocket` in `Request`), never because `remoteAddress` is empty: a reset TCP socket also reports no address. It is trusted regardless of `request.trustedProxies`.
- **Proxy Header Trust (`isFromOdacProxy`):** Only the ODAC proxy writes `X-Odac-Connection-*`, and it signs them in `X-Odac-Connection-Signature` (HMAC-SHA256 with `ODAC_PROXY_KEY` over `odac-connection-v1`, t, method, Host, URL, address, ssl; 60s window). The signed string and its test vector are shared with the ODAC server (`internal/proxysig`); never change one side alone. `ODAC_APP` and `ODAC_PROXY_KEY` are read once when `src/Request/TrustedProxy.js` loads. Order: proxy socket, then a valid signature (both win over any `trustedProxies`), then an explicit list, then with a key nothing else (a private peer without a signature is a neighbour or a published port). Without a key: under ODAC loopback + private TCP peers (older servers, and containers started before the server update); not under ODAC nobody. ODAC tunnels arrive signed: the ODAC server's tunnel agent re-signs what ODAC Cloud reported about the visitor. `Request.fromTrustedProxy` follows the same rule, which also gates Host-derived magic links.
- **Socket Never Fatal:** Any proxy socket failure is logged and the app keeps serving TCP; the ODAC Proxy falls back to TCP per request. Only the TCP listener's bind error exits with `EXIT_FATAL`.
