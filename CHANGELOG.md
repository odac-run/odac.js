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
