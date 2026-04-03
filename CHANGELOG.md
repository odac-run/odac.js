### ✨ What's New

- **database:** add Write-Behind Cache with counter, update, and batch insert buffering
- **ipc,database:** extend Ipc with atomic ops and delegate WriteBuffer state to Ipc layer

### 🛠️ Fixes & Improvements

- atomic queue drain, transaction-safe flush, hgetall clone & unhandled rejection
- **odac:** ensure proper token query parameter handling in get method
- **storage:** ensure synchronous operations for put and remove methods



---

Powered by [⚡ ODAC](https://odac.run)

### ⚙️ Engine Tuning

- **test:** remove unused fsPromises and standardize async I/O in View tests

### 📚 Documentation

- add quick start guide and register in documentation index

### 🛠️ Fixes & Improvements

- add raw attribute support to `<odac get>` tag for unescaped HTML output
- improve title extraction logic and optimize data-odac-navigate attribute injection in View rendering
- prevent data-odac-navigate injection into closing HTML tags



---

Powered by [⚡ ODAC](https://odac.run)

### ⚙️ Engine Tuning

- replace global Odac reference with private instance and update dependency overrides for security hardening
- **test/view:** remove unused CACHE_DIR variable in parseOdacTag tests

### ✨ What's New

- **client:** log malformed data-odac-parts JSON to ease debugging
- **view:** smart AJAX part diffing with selective re-render

### 🛠️ Fixes & Improvements

- **route:** encode X-Odac-Parts header values to prevent splitting errors
- **View:** escape single quotes in template expressions to prevent syntax errors
- **view:** prevent template injection by escaping backslashes in dynamic parser



---

Powered by [⚡ ODAC](https://odac.run)

### security

- **template:** add noopener to external footer links to mitigate reverse tabnabbing
- **template:** add rel="noopener" to all external links to prevent tabnabbing without losing referer analytics

### ✨ What's New

- **client:** add native View Transition API support via odac-transition attribute
- Implement a complete UI redesign using Tailwind CSS, introduce new components, and update branding to ODAC.

### 📚 Documentation

- Add documentation for auto-navigation injection in the View Engine and SSR.
- **template:** correct casing for Odac object api references in comments
- **views:** clarify template syntax as equal-status with usage guidelines

### 🛠️ Fixes & Improvements

- **client:** clear stale view transition names on aborted navigation promises
- **client:** decode HTML entities in document title to prevent XSS vulnerabilities
- **template:** sync active nav state properly across desktop and mobile menus



---

Powered by [⚡ ODAC](https://odac.run)

### doc

- Introduce WebSocket routing and controllers, update request handling, and refactor language and validator modules to use async operations.

### ⚙️ Engine Tuning

- **view:** extract <odac:img> parsing to Image.parse() method

### ✨ What's New

- **image:** add Odac.image() API for programmatic image URL generation
- **view:** add <odac:img> tag with on-demand image processing
- **view:** add warning message when sharp dependency is unavailable
- **view:** implement human-readable cache filenames and mtime-based cache busting

### 📚 Documentation

- **steering:** correct module system standard to explicitly dictate CommonJS preserving architectural consistency
- **View/Image:** correct cache eviction jsdoc from LRU to FIFO reflecting O(1) performance trait

### 🛠️ Fixes & Improvements

- **auth:** prevent duplicate login tokens during magic link verification
- Refactor `fs` module usage to `node:fs` and `fs.promises`, and update string manipulation from `substr` to `slice`.
- **request:** use global.Odac namespace for consistent access
- **route:** improve controller loading error handling with specific error messages
- **route:** update inline function reference on hot reload
- **View/Image:** clamp unrequested output formats to supported whitelist to prevent processing crashes



---

Powered by [⚡ ODAC](https://odac.run)

### doc

- Introduce WebSocket routing and controllers, update request handling, and refactor language and validator modules to use async operations.

### ⚙️ Engine Tuning

- **view:** extract <odac:img> parsing to Image.parse() method

### ✨ What's New

- **image:** add Odac.image() API for programmatic image URL generation
- **view:** add <odac:img> tag with on-demand image processing
- **view:** add warning message when sharp dependency is unavailable
- **view:** implement human-readable cache filenames and mtime-based cache busting

### 📚 Documentation

- **steering:** correct module system standard to explicitly dictate CommonJS preserving architectural consistency
- **View/Image:** correct cache eviction jsdoc from LRU to FIFO reflecting O(1) performance trait

### 🛠️ Fixes & Improvements

- **auth:** prevent duplicate login tokens during magic link verification
- Refactor `fs` module usage to `node:fs` and `fs.promises`, and update string manipulation from `substr` to `slice`.
- **request:** use global.Odac namespace for consistent access
- **route:** improve controller loading error handling with specific error messages
- **route:** update inline function reference on hot reload
- **View/Image:** clamp unrequested output formats to supported whitelist to prevent processing crashes



---

Powered by [⚡ ODAC](https://odac.run)

### ⚙️ Engine Tuning

- **client:** extract ws connection logic and fix recursive sharedworker reconnects reconnect bug
- **client:** remove redundant truthy check for websocket token
- **route:** remove useless variable assignment for decodedUrl

### ⚡️ Performance Upgrades

- **client:** remove redundant token consumption during websocket initialization

### 📚 Documentation

- **README:** enhance security section with detailed CSRF protection features

### 🛠️ Fixes & Improvements

- **client:** enhance websocket reconnection logic with attempt tracking and timer management
- **client:** preserve existing websocket subprotocols & add try/catch layer to token provider
- **route:** improve URL decoding and public path handling for file requests
- **route:** sanitize decoded URL and improve public path validation
- **route:** use robust path.extname instead of string splitting for mime type resolution
- **websocket:** implement token provider for dynamic token handling on reconnect



---

Powered by [⚡ ODAC](https://odac.run)

### doc

- **forms:** update backend and frontend forms documentation with practical usage patterns and improved descriptions
- **validation:** enhance backend validation documentation with detailed usage patterns and examples

### ⚙️ Engine Tuning

- **test:** restructure test suite into class-scoped directories and method-level atomic files

### ✨ What's New

- **database:** add debug logging for schema parsing failures in nanoid metadata loader
- **database:** introduce NanoID support for automatic ID generation in schema
- **release:** enhance commit analyzer with release rules and custom labels
- **shutdown:** implement graceful shutdown for IPC, Database, and Cron services

### 📚 Documentation

- **database:** remove underscore from nanoid example to reflect true alphanumeric output

### 🛠️ Fixes & Improvements

- **Auth:** handle token rotation for WebSocket connections and update active timestamp
- **core:** explicitly stop session GC interval during graceful shutdown
- **database:** namespace nanoid schema cache by connection to prevent table to prevent collisions
- **forms:** initialize ODAC form handlers on DOMContentLoaded and after AJAX navigation
- **manageSkills:** correct targetPath assignment for skill synchronization
- **Validator:** pass Odac instance to Validator for improved access to global methods



---

Powered by [⚡ ODAC](https://odac.run)

### doc

- enhance AI skills documentation with structured YAML front matter and detailed descriptions

### ⚙️ Engine Tuning

- **database:** centralize knex connection bootstrap for runtime and CLI

### 📚 Documentation

- add section for loading and updating AI skills in projects

### 🛠️ Fixes & Improvements

- **auth:** improve token rotation logic and ensure proper cookie attributes
- **cli:** parse .env values consistently in migration loader
- **config:** update interpolation regex to support variable names with hyphens
- **migration:** normalize column-level unique constraints and enhance idempotency in migrations
- **release:** add version output to release notes and update release title condition



---

Powered by [⚡ ODAC](https://odac.run)

### ⚙️ Engine Tuning

- Extract MIME type definitions into a dedicated module.

### ⚡️ Performance Upgrades

- prevent redundant database table migration calls by introducing a static cache to track completed migrations.

### ✨ What's New

- add comprehensive ODAC Agent instructions and guidelines
- **auth:** implement enterprise refresh token rotation with grace period and session persistence
- Automatically parse JSON responses in client-side AJAX requests based on the `Content-Type` header.
- implement comprehensive AI agent skills system and automated CLI setup

### 🛠️ Fixes & Improvements

- add HTML escaping functionality to Form class and corresponding tests
- **ai:** correct target path for syncing AI skills
- **auth:** replace magic number with constant for rotated token threshold
- **auth:** replace magic number with constant for token rotation grace period
- enhance odac:form parser with nested quotes and dynamic binding support
- **route:** support nested property paths in actions and resolve App class conflict
- **view:** ensure odac:for with 'in' attribute parses correctly as javascript
- **view:** implement clear attribute in odac:form to control auto-clearing



---

Powered by [⚡ ODAC](https://odac.run)

### ⚙️ Engine Tuning

- Improve disposable domain cache management by relocating the cache path, ensuring directory existence, and standardizing error logging.
- Migrate file system operations in Mail and View to use async `fs.promises` for non-blocking I/O, aligning with new memory.md guidelines.
- remove unused `WebSocketClient` variable assignments in `WebSocket.test.js`
- streamline cache file reading by removing redundant access check.
- **validator:** Migrate file operations to `fs.promises` for asynchronous I/O and enhance security with explicit content sanitization.

### ⚡️ Performance Upgrades

- Optimize parametric route matching by implementing a two-phase, pre-indexed lookup strategy grouped by segment count.

### ✨ What's New

- Add configurable max payload size and message rate limiting options to WebSocket routes.
- Refined pre-push security audit to omit dev dependencies, optimized variable initializations, enhanced test mocks with `writeHead` and `finished` properties, introduced conditional `setTimeout` for request handling, and improved code formatting in client-side WebSocket and AJAX logic.
- update `.gitignore` to no longer ignore package manager lock files and to ignore the `storage/` directory

### 🛠️ Fixes & Improvements

- Enhance route directory not found error logging and add ODAC casing convention to memory rules.
- Set owner-only read/write permissions (0o600) for temporary cache files created during validation.
- suppress tailwind process stdout output
- Update default Unix socket path and enhance socket connection error handling with specific guidance for `ENOENT` errors.
- Update Tailwind CSS watch flag to '--watch=always' and refine child process stdio configuration.



---

Powered by [⚡ ODAC](https://odac.run)

### agent

- Clarify logging strategies for development and production environments

### deps

- update `tar` override version and add `@semantic-release/npm` override.

### ⚙️ Engine Tuning

- add JSDoc and default parameter to `Auth.user` method for improved clarity and robustness.
- enable method chaining for cron job condition definitions
- Enhance cryptographic security by using CSPRNG for token generation, SHA-256 for encryption key derivation, and adding clarifying configuration comments.
- Improve authentication logic by adopting fail-fast patterns, upfront promise resolution, and optimized loop control, aligning with new code quality guidelines.
- Improve view file reading by using `fsPromises.open` for better resource management and atomic operations.
- Migrate route and middleware loading to asynchronous file system operations for improved performance.
- Remove redundant `fs.existsSync` checks before `fs.mkdirSync` and add `EEXIST` handling for `fs.writeFileSync`.
- remove unused nodeCrypto import from Config.test.js
- rename config.json to odac.json for brand consistency
- Streamline default CSS file creation using `fs.writeFileSync` 'wx' flag.
- Use raw Buffer for encryption key hashing, aligning with enterprise-grade development standards.

### ⚡️ Performance Upgrades

- Implement enterprise-grade HTTP server performance configurations
- Optimize file serving by eliminating redundant `fs.stat` calls and deriving content length directly from the read file.
- **route:** implementation of async I/O and metadata caching for static assets
- **view:** switch to async I/O and implement aggressive production caching

### ✨ What's New

- add built-in tailwindcss v4 support with zero-config
- Enhance cron job scheduling with new `.at()` and `.raw()` methods, update cron documentation.
- Enhance Tailwind CSS watcher to prioritize local CLI over npx for improved reliability and adjust shell option accordingly.
- **framework:** add Odac.session() helper and update docs
- implement Class-Based Controllers support and update docs
- Implement conditional environment variable loading, configure server workers based on debug mode
- Replaced bcrypt with native Node.js crypto.scrypt for hashing, removed bcrypt and axios dependencies, and updated related validation checks.
- support multiple Tailwind CSS entry points in build and dev processes.

### 📚 Documentation

- add documentation for multiple CSS file support
- add project structure overview to README
- Add Tailwind CSS v4 integration to README features list
- Introduce architectural and cluster safety notes to Token, Ipc, and Storage modules.

### 🛠️ Fixes & Improvements

- Add null safety checks for `odac.Request` and its `header` method when determining the default language.
- add options support to authenticated routes (GET/POST)
- Conditionally initialize Odac request-dependent components and provide a dedicated Odac instance with cleanup to cron jobs.
- Enhance server port configuration to prioritize command-line arguments and environment variables
- Initialize session in Route.js during form processing to ensure proper session availability before access, aligning with new coding standards.
- **package:** resolve high severity npm vulnerabilities
- Prevent form token expiration errors by dynamically generating forms at runtime.
- Prevent middleware race conditions by synchronously capturing state and improve Tailwind CSS watcher robustness with auto-restart.
- Refine error message styling in form validation
- Replace insecure token generation with cryptographically secure random bytes for `token_x` and `token_y`.
- **session:** change cookie SameSite policy to Lax for OAuth support



---

Powered by [⚡ ODAC](https://odac.run)

### Fix

- Resolve WebSocket handshake error by echoing subprotocol header

### Refactor

- Unified WebSocket architecture and fixed race conditions

### deps

- update mysql2 dependency to ^3.16.0

### ⚙️ Engine Tuning

- Add type checks for page assignments and a null check for the `authPage` method's `authFile` parameter.
- extract and trim validation rule names for clearer inverse rule processing.
- extract HTML stripping logic into a private helper method and apply it to text content generation.
- migrate custom `odac:field` tag to `odac:input` with updated parsing logic and regex patterns.
- migrate session locking from in-memory object to `Odac.Storage` for persistence.
- Move form message clearing logic to the beginning of form submission.
- move middleware execution to occur after URL parameter processing.
- pass PR body to github-script action via environment variable
- Remove duplicate data-error-email attribute assignment.
- rename `requestMagicLink` method to `magic` in Auth and update its usages and documentation
- Rename authentication token and session cookie keys from 'candy' to 'odac'.
- rename internal `Odac` class to `_odac`
- Rename Mysql to Database and implement connection pooling
- Update default magic link table name from 'magic_links' to 'odac_magic'.
- Use `crypto.randomBytes` for client and session ID generation instead of MD5 hashing.
- use `node:crypto.randomBytes` for generating unique IDs instead of `Date.now()` and `Math.random()`
- use file descriptor for mail template reading to ensure resource closure

### ✨ What's New

- add `_odac/form` POST route with CSRF token validation
- Add `!disposable` validation rule to block temporary email providers by fetching and caching a daily updated blocklist.
- Add console error for missing controller files
- Add custom template rendering engine with caching to Mail service and enhance magic link email options.
- Add magic link rate limiting, expired link cleanup, and open redirect protection for magic link redirects.
- add passwordless auto-registration for magic links, improve URL query decoding, and disable token validation for the magic link verification route.
- Add request language property from Accept-Language header, defaulting to 'en'.
- Add session cooldown for magic link requests and return explicit errors for rate limits, updating documentation.
- Allow direct page route definition when a file is provided.
- Allow specifying and using a redirect URL for magic link authentication.
- emit 'ping' event when receiving a WebSocket PING frame
- Enable passing variables directly in view configuration objects for page routes and update documentation.
- Enable sending plain text and raw HTML emails without templates in the mail service.
- HTML Mail delivery via direct ODAC Mail Server
- Ignore database table not found errors when looking up users by email.
- Implement and document auto-clearing of form inputs on successful submission, controllable via a `clear` attribute.
- Implement backend-to-frontend data sharing via `Odac.share` and…
- implement built-in IPC system with Memory and Redis drivers
- Implement dynamic session garbage collection with simple and batch cleaning modes based on session count.
- Implement graceful shutdown for primary and worker processes in the cluster.
- Implement magic login functionality
- Implement magic login functionality with new routes, internal handlers, and form processing, while removing a generic form route.
- Implement passwordless signup by auto-registering new users during magic link verification and adding `node:crypto` for random password generation.
- Implement server actions for forms, allowing `Controller.method` as the action and dispatching internally via a generic endpoint.
- introduce `Odac.DB.nanoid()` helper, centralize its implementation, and update authentication ID generation strategy documentation.
- Introduce Nano IDs for primary keys and cookie identifiers, streamlining user insertion logic.
- introduce service classes in a dedicated directory with naming collision handling and refine route authentication logic.
- Introduce Storage module to encapsulate LMDB operations and session garbage collection.
- Migrate session management from in-memory to LMDB, enable server clustering, and add session garbage collection.
- Modernize db layer with magic api and migrations
- Modernize db layer with magic api and migrations
- Render form success and error messages as HTML using a new `textToHtml` utility.
- Return generic success message for user not found when auto-register is enabled to prevent enumeration.
- Server Clustering & Persistent Session Management
- support string-based WebSocket controller paths and update documentation
- Update route loading to execute function-exported route definitions with Odac.
- Update session private key hashing algorithm from MD5 to SHA256.

### 📚 Documentation

- Add magic links documentation.
- Fix typo in controller classes documentation
- overhaul README to detail new Node.js framework features, advanced capabilities, updated quick start instructions, and license.
- remove redundant html code block tag
- remove server documentation index.
- Replace old database connection and MySQL guides with new getting started, query basics, advanced queries, and migrations documentation.
- Standardize framework name capitalization from Odac to ODAC across documentation.
- Update database interaction examples from `Odac.Mysql` to `Odac.DB`.
- update database query examples to include `.select()` and variable assignments.

### 🛠️ Fixes & Improvements

- Add error handling for cache file access to ensure validation update proceeds.
- Add explicit response termination for middleware and redirects, and pass page file path to request.
- Adjust session key counting range
- Consume all magic link tokens for an email instead of just the used one to prevent reuse.
- Correct `odac` special variable path resolution by removing `/src` instead of `/framework/src`.
- Enable `MiddlewareChain` to automatically use auth handlers when created via `Route.auth.use`.
- Ensure all HTML tags are recursively stripped when converting HTML to plain text.
- Ignore `data:` and `vbscript:` pseudo-protocols when processing anchor hrefs.
- Implement form token rotation on successful form submission without redirect and update client-side form with the new token.
- Initialize cron interval only in the primary cluster process.
- Introduce `setSession` method for client ID initialization and optimize internal session and cookie storage.
- log errors when ensuring the magic link table exists instead of ignoring them
- Log Odac Auth errors when ensuring token table exists instead of ignoring them.
- Prevent navigation to `data:` and `vbscript:` URLs.
- re-register form submit handler when its `data-odac-form` attribute changes to ensure correct event capture.
- recursively strip nested script and style tags when sanitizing HTML
- Relax sameSite cookie policy to Lax and refactor redirect handling.
- remove all socket listeners when closing or disconnecting the WebSocket.
- Remove early exit from token hash check loop to mitigate timing attacks.
- return non-function default connection properties directly instead of attempting to bind them
- return registration error on unique check failure.
- Robustly extract multipart boundary from request body.
- serve static files via `createReadStream` and pipe streamable content to response.
- Validate error route cache handler is a function in Request abort method.



---

Powered by [⚡ ODAC](https://odac.run)

### 🛠️ Fixes & Improvements

- Simplify project initialization by removing directory emptiness validation and extraneous comments.



---

Powered by [⚡ ODAC](https://odac.run)

### Framework

- HTML Email

### ⚙️ Engine Tuning

- 'for' and 'list' directive argument handling
- externalize semantic-release configuration to `.releaserc.js` with enhanced changelog generation and update release workflow permissions.
- Hub polling
- Modular Config
- New default web template
- Proxy logic
- rebrand from CandyPack to Odac
- Refactor documentation files
- restructure for standalone framework package
- View rendering to support async operations

### ✨ What's New

- Add <candy:form> system with automatic validation and DB insert
- add <candy:login> component for zero-config registration
- add <candy:register> component for zero-config registration
- Add cloud integration
- Add DDoS Protection Firewall
- Add GitHub Actions workflows for test coverage, auto PR descriptions, and CodeQL analysis.
- Add Jest for testing
- Add Jest for unit testing and code coverage
- add semantic-release
- add semantic-release with npm publishing
- Add skeleton-aware navigation and auto-navigation support
- Add support for controller classes and update docs
- Added CLI prefix arguments support
- Development Server Mode
- Environment variable support
- **framework:** add Early Hints (HTTP 103) support with zero-config
- **Framework:** Add middleware support
- **Framework:** Custom Cron Jobs
- **Framework:** Support multiple validation checks per field
- HTTP2 & Server-Sent Events (SSE) Support
- Introduce CLI for project initialization and development, refactor framework dependencies, and add automated release workflow.
- Make package.json name, version, and dependency updates unconditional.
- Modernize view template syntax with <candy> tags
- No-Code AJAX Navigation
- Re-enable release workflow and configure semantic-release with NPM provenance.
- **server:** New Logging Module
- Synchronize main with dev branch
- WebSocket Support

### 📚 Documentation

- Add AGENTS.md and update contribution guidelines
- Add Candy.Var utility documentation
- clarify difference between candy get and var tags
- Expand and update view system documentation
- Framework Docs
- Remove 'coming soon' from documentation link
- Revamp database docs: connection and queries
- Simplify and standardize documentation titles
- split template syntax into separate detailed pages

### 🛠️ Fixes & Improvements

- Add input validation to Auth.check method
- Add memory-safe timers and auto-cleanup for streaming
- Add missing conventional-changelog-conventionalcommits dependency
- Add WebSocket cleanup
- Adjust route reload timing and cache invalidation
- Correct license and supported version in docs
- Enable object stringification in MySQL connection
- escape backslash characters in View.js regex replacements
- Escape backticks earlier in view content processing
- Escape backticks in cached view templates
- File type check in Route controller path logic
- **Framework:** Add error handling for config file parsing
- **Framework:** No Controller View
- Handle null and undefined in Var.html()
- Make husky prepare script non-failing
- Preserve template literals in <script:candy> blocks
- Prevent replace error when candy get value is undefined
- Refactor route controller lookup and page handling
- release workflow, update package config with MIT license and reduced dependencies, fix View.js regex handling, and refine template scripts.
- **server:** Refactor server restart and initialization logic
- Support view config object in authPage third parameter


### 💥 BREAKING CHANGES

- rebrand from CandyPack to Odac (#88)


---

Powered by [⚡ ODAC](https://odac.run)
