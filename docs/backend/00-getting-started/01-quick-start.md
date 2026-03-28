## 🚀 Quick Start

ODAC is built for speed and zero-configuration. You can bootstrap a production-ready, high-performance web application in seconds.

### 1. Requirements

- **Node.js:** 18.0.0 or higher.
- **npm:** 8.0.0 or higher.

---

### 2. Initialize Your Project

The standard way to start an ODAC project is using the interactive **init** command via `npx`. Run this in your terminal:

```bash
npx odac init my-app
```

**What this does:**
- Creates a new folder named `my-app`.
- Copies the ODAC enterprise skeleton (controllers, routes, views, etc.).
- Initializes `package.json` with the latest ODAC framework dependency.
- Runs `npm install` automatically.

---

### 3. Launch Development Mode

Navigate into your project directory and start the smart development server:

```bash
cd my-app
npm run dev
```

Your app is now live at `http://localhost:1071` (default port).

**Features enabled in Dev Mode:**
- **Hot-reloading:** The server and cluster workers restart instantly on backend changes.
- **Zero-Config Tailwind CSS v4:** Automatically watches and compiles your styles.
- **Detailed Stack Traces:** Helps you debug errors quickly in the browser and console.

---

### 4. Setup AI Agent Skills

ODAC is designed to be **AI-First**. It provides pre-built "skills" (knowledge files) that teach your AI coding assistant (like Antigravity, Claude, Cursor, or Windsurf) exactly how to write ODAC-compatible code.

Run this command inside your project root:

```bash
npx odac skills
```

Follow the interactive prompt to sync the documentation and patterns directly into your IDE's agent configuration folder.

---

### 5. Essential Commands

| Command | Description |
| :--- | :--- |
| `npm run dev` | Start development server with hot-reload & styles. |
| `npm run build` | Compile and minify styles for production. |
| `npm start` | Run the application in high-performance production mode. |
| `npx odac migrate` | Run pending database migrations. |
| `npx odac skills` | Sync/Update AI Agent knowledge files. |

---

### 6. Next Steps

- **Define Routes:** Open `route/web.js` to see how URLs are mapped to views.
- **Project Structure:** Learn how to organize your [file/folder layout](../02-structure/01-typical-project-layout.md).
- **Build Views:** Check the `view/` directory for your HTML templates.
- **Manage Database:** Update `odac.json` to connect to PostgreSQL, MySQL, or SQLite.
