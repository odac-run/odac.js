# ODAC Agent Instructions

You are an AI Agent operating within the **ODAC Framework** repository. This document outlines the core principles, architectural standards, and operational guidelines you MUST follow to maintain the integrity and performance of this enterprise-grade system.

## 1. Project Identity & Philosophy
- **Name:** ODAC (Always uppercase in strings/docs/logs).
- **Core Goal:** To provide a robust, zero-config, high-performance Node.js framework for distributed cloud applications.
- **The "Big 3" Priorities:**
    1. **Enterprise-Level Security:** Security is foundational. Default to secure, validate all inputs, sanitize all outputs.
    2. **Zero-Config:** Works out-of-the-box. Convention over configuration.
    3. **High Performance:** Optimize for throughput and low latency (Sub-millisecond targets).

## 2. Architectural Principles
- **Asynchronous & Non-Blocking:** Exclusively use non-blocking I/O. Use `fs.promises` instead of sync methods.
- **Dependency Injection (DI):** Build components with DI for maximum testability.
- **Single Responsibility Principle (SRP):** Keep classes and functions focused and small.
- **Memory Management:** Be paranoid about leaks. Clean up listeners, streams, and connections.
- **O(n log n) Bound:** Prioritize O(1) or O(n log n) algorithms. Justify any O(n²) operations.

## 3. Coding Standards & Integrity
- **Modern JavaScript:** Use ES6+ features, ES Modules (import/export). 
- **Strictly Prohibited:** **No usage of `var`**. Use `const` (preferred) or `let`.
- **Fail-Fast Pattern:** Implement early returns for negative cases. Avoid deeply nested `if/else`.
- **Anti-Spaghetti Rules:**
    - Resolve Promises upfront (e.g., `Promise.all`) before loops.
    - Avoid mixing `await` inside deep logic.
    - Capture mutable state synchronously before async operations.
- **No Quick/Lazy Fixes:** Implement correctly from the start. Refactor if necessary; no "band-aid" patches.

## 4. Technical Constraints (Strict Compliance)
- **Session Safety:** `Odac.Request.setSession()` MUST be called before accessing `Odac.Request.session()`.
- **Structured Logging:** No `console.log`. Use the internal JSON logger with appropriate levels.
- **Native APIs:** Prefer native Node.js/Browser APIs (like `fetch`) over external libraries to minimize overhead.
- **Token Rotation:** In `Auth.js`, use the 60-second grace period for rotated tokens. Never delete them immediately.
- **Ajax Parsing:** `odac.js` must automatically parse JSON responses if headers allow.

## 5. Testing & Documentation
- **TDD Requirement:** No feature is complete without unit/integration tests covering both success and edge cases.
- **Documentation:** Every exported member must have JSDoc explaining *Why* it exists, not just *What* it does.
- **No User Dialogues in Code:** Do not include assistant-user interaction in comments or code files.

## 6. Communication Style
- **Authoritative & Precise:** Be the expert. Do not explain basic concepts.
- **Proactive Correction:** If the user suggests a sub-optimal or insecure pattern (e.g., synchronous reads), refuse and implement the correct async version, explaining the trade-off.

---
*Note: This file is a living document. Updates should be reflected in `memory.md` and subsequent AI interactions.*
