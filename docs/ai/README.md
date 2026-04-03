# ODAC AI Agent Master Guide

Welcome! If you are reading this document, you are an AI Agent tasked with developing a project using the ODAC (Open Distributed Application Container) Framework.

ODAC is a high-performance, enterprise-grade, and zero-configuration Node.js framework. Your mission is to produce secure, scalable code while strictly adhering to the framework's principles.

## Core Mandate
When developing with ODAC, you must not only write code but also leverage the framework's optimized structures (Route, View, Database, Hub, etc.) in the most efficient way possible.

## Agent Principles
1.  **Performance Focused**: Always aim for O(1) or O(n log n) complexity. Avoid inefficient queries like `SELECT *`.
2.  **Security-by-Default**: Validate all input data using the `Validator`. Trust the auto-sanitizing View engine but maintain manual control in critical areas.
3.  **Error Management**: Never swallow errors. Use framework-specific methods like `Odac.Request.error()` to return structured error messages.
4.  **Clean Code**: Keep functions small (Single Responsibility) and adhere to ESM (ES Modules) standards.

## How to Use This Guide
The `skills/` directory contains a master `SKILL.md` that indexes specialized rules for each module. When adding a feature, you MUST refer to these rules and base your implementation on the "Reference Patterns".

## Core Rules
Detailed instructions are organized into Backend and Frontend categories:

### Backend
- `backend/authentication.md`: Sessions, Auth, and Realtime Hubs.
- `backend/config.md`: Configuration management and environment variables.
- `backend/controllers.md`: Request handling and Class-Based Controllers.
- `backend/cron.md`: Scheduled background tasks and automation.
- `backend/database.md`: High-performance query builder usage, Write-Behind Cache (buffered counters, last-write-wins updates, batch inserts).
- `backend/forms.md`: Form processing and validation logic.
- `backend/ipc.md`: Inter-Process Communication and state sharing.
- `backend/mail.md`: Transactional email sending.
- `backend/request_response.md`: Handling Odac.Request and Odac.Response.
- `backend/routing.md`: Route definitions, Middlewares, and Error Pages.
- `backend/storage.md`: Persistent key-value storage (LMDB).
- `backend/streaming.md`: Server-Sent Events (SSE) and Streaming API.
- `backend/structure.md`: Project organization and Service Classes.
- `backend/translations.md`: Multi-language support (i18n).
- `backend/utilities.md`: Odac.Var (String Manipulation) and Flow Control.
- `backend/validation.md`: Input sanitization and security checks.
- `backend/views.md`: Template syntax, skeletons, and server-side JS.

### Frontend
- `frontend/core.md`: Framework lifecycle, page scoping, and storage.
- `frontend/forms.md`: AJAX form handling and API requests.
- `frontend/navigation.md`: AJAX Navigation (SPA) behavior.
- `frontend/realtime.md`: WebSocket Hubs and EventSource usage.

---

**Remember:** You are an ODAC expert. Every line of code you write should reflect the "Enterprise" spirit of the framework.
