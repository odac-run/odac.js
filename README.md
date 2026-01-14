
# ⚡ ODAC.JS

**ODAC** is a lightweight, high-performance Node.js framework designed to build modern, scalable web applications with ease. It allows developers to focus on building features rather than configuring boilerplate, offering a complete toolkit for web development.

## ✨ Key Features

*   🚀 **Developer Friendly:** Simple setup and intuitive API design let you start building immediately.
*   🎨 **Built-in Tailwind CSS:** Zero-config integration with Tailwind CSS v4. Automatic compilation and optimization out of the box.
*   🔗 **Powerful Routing:** Create clean, custom URLs and manage infinite pages with a flexible routing system.
*   ✨ **Seamless SPA Experience:** Automatic AJAX handling for forms and page transitions eliminates the need for complex client-side code.
*   🛡️ **Built-in Security:** Automatic CSRF protection and secure default headers keep your application safe.
*   🔐 **Authentication:** Ready-to-use session management, password hashing, and authentication helpers.
*   🗄️ **Database Agnostic:** Integrated support for major databases (PostgreSQL, MySQL, SQLite) and Redis via Knex.js.
*   🌍 **i18n Support:** Native multi-language support to help you reach a global audience.
*   ⏰ **Task Scheduling:** Built-in Cron job system for handling background tasks and recurring operations.

## 🛠️ Advanced Capabilities

### ⚡ Cluster-Ready IPC
Built for scale from day one, ODAC includes a powerful Inter-Process Communication (IPC) system.
*   **Unified API:** Use the same `get`, `set`, `publish`, and `subscribe` methods regardless of the underlying driver.
*   **Zero-Config Clustering:** The default `memory` driver automatically syncs data between Node.js cluster workers without external dependencies.
*   **Redis Support:** Switch to the `redis` driver with a single config change to scale horizontally across multiple servers.

### 🔌 Native WebSocket Support
Real-time features are a first-class citizen in ODAC.
*   **Integrated Server:** No need for third-party libraries; ODAC features a lightweight, native WebSocket implementation.
*   **Room System:** Easily manage user groups with built-in `join`, `leave`, and `broadcast` to room functionality.
*   **Route Integration:** define WebSocket endpoints directly in your router alongside HTTP routes.

### 🎨 Powerful Templating
ODAC's view engine combines the power of JavaScript with intuitive HTML tags.
*   **Logic Tags:** Use `<odac:if>`, `<odac:for>`, and `<odac:else>` for clean control flow.
*   **Async Support:** Fully asynchronous rendering allows fetching data directly within your views using `await`.
*   **Safety:** Automatic escaping prevents XSS while allowing raw HTML output when explicitly requested.

## 🚀 Quick Start

Get your new ODAC project up and running in seconds using our CLI.

### Create a new project

```bash
npx odac init my-app
```

### Start development

```bash
cd my-app
npm run dev
```

## 📚 Documentation

For detailed guides, API references, and examples, visit our [official documentation](https://docs.odac.run).

## 📄 License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.
