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
