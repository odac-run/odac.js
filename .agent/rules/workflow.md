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
