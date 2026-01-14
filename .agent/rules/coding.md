---
trigger: always_on
---

# Coding Standards & Best Practices

## 1. Testing Strategy
- **Rule:** No feature is complete without tests.
- **Goal:** Maintain stability and prevent regressions.
- **Action:** Write unit tests for logic and integration tests for API endpoints.

## 2. Dependency Management
- **Philosophy:** "Less is more."
- **Rule:** Avoid external dependencies unless absolutely necessary.
- **Preference:** Prioritize native Node.js modules (`fs`, `http`, `crypto`, etc.) to reduce bundle size and security attack surface.

## 3. Error Handling
- **Rule:** Fail loudly and clearly.
- **Practice:** Use custom Error classes where possible.
- **Message:** Error messages should guide the developer on how to fix the issue, not just say "Error".

## 4. Modern JavaScript
- **Standard:** Use ES6+ features (Async/Await, Arrow functions, Destructuring).
- **Modules:** Strict adherence to ES Modules (import/export).
