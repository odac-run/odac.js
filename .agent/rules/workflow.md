---
trigger: always_on
---

# Development Workflow Rules

## 1. Quality Assurance (Linting)
- **Rule:** **ALWAYS** runs lint checks after writing or modifying code.
- **Action:** Execute the project's linting command (e.g., `npm run lint` or `eslint .`) to verify code compliance.
- **Strictness:** Do not mark a task as complete if lint errors persist. Fix them immediately.

## 2. Documentation Hygiene
- **Rule:** Documentation must be kept in sync with code changes.
- **Trigger:** Adding a new feature, modifying an API, or changing configuration behavior.
- **Action:** Update the relevant `.md` files (README, API docs, etc.) or JSDoc comments.
- **Goal:** Ensure that the documentation is never stale and accurately reflects the current state of the codebase.

## 3. AI Skills Sync
- **Rule:** `docs/ai/skills/` is what agents building ODAC apps read. It is a second documentation target, separate from `docs/backend/` and `docs/frontend/`, and goes stale silently.
- **Trigger:** Any change to public behavior: a new option or API, a changed default, a changed error or failure mode, or a removed feature. Internal refactors and bug fixes that keep the documented behavior do not need it.
- **Action:** Before reporting the task done, update the matching skill file (rules, reference pattern, best practice). Update `docs/ai/skills/SKILL.md` and `docs/ai/README.md` when a skill's scope changes. When the change makes an old pattern wrong (e.g. a hand-written limiter), say so explicitly in the skill.
- **Map:**

| Source | Skill file(s) |
|--------|---------------|
| `src/Route.js`, `src/Route/Middleware.js`, `src/Route/RateLimit.js`, `src/Route/Internal.js` | `backend/routing.md` (+ `backend/authentication.md` for auth routes) |
| `src/Route/Cron.js` | `backend/cron.md` |
| `src/Auth.js`, `src/Token.js` | `backend/authentication.md` |
| `src/Request.js` | `backend/request_response.md`, `backend/utilities.md` |
| `src/Database.js`, `src/Database/*` | `backend/database.md`, `backend/migrations.md` |
| `src/Ipc.js` | `backend/ipc.md` |
| `src/Storage.js` | `backend/storage.md` |
| `src/Stream.js` | `backend/streaming.md` |
| `src/WebSocket.js` | `backend/routing.md`, `backend/controllers.md`, `frontend/realtime.md` |
| `src/View.js`, `src/View/*` | `backend/views.md`, `backend/forms.md`, `backend/image-processing.md` |
| `src/Validator.js` | `backend/validation.md`, `backend/forms.md` |
| `src/Config.js`, `src/Env.js` | `backend/config.md` |
| `src/Mail.js` | `backend/mail.md` |
| `src/Lang.js` | `backend/translations.md` |
| `src/Var.js` | `backend/odac-var.md` |
| `src/Server.js`, `src/Odac.js` | `backend/structure.md`, `backend/streaming.md` (timers) |
| `client/odac.js` | `frontend/*.md` |
| `bin/`, `src/Cli/*` | `frontend/scripts.md`, `backend/migrations.md` |

