## 🚀 CLI Commands & Deployment

ODAC comes with a powerful CLI to manage your project's lifecycle, from development to production.

### Development Mode (`dev`)

Start the development server with **hot-reloading** and **automatic Tailwind CSS compilation**:

```bash
# Using npm script
npm run dev

# Using ODAC directly
npx odac dev
```

**What it does:**
- Starts the Node.js server (default port `1071`).
- **Zero-Config Tailwind:** Automatically watches and compiles your classes.
- **Watch Mode:** Recompiles CSS instantly when you change files.

### Production Build (`build`)

Prepare your application for production deployment. This command compiles and modifies your assets for optimal performance.

```bash
# Using npm script
npm run build

# Using ODAC directly
npx odac build
```

**What it does:**
- **Compiles CSS:** Generates the final `public/assets/css/app.css`.
- **Minification:** Compresses the CSS to reduce file size.
- **One-off Run:** Runs once and exits. Does not start a server.

### Production Server (`start`)

Start the application in **production mode**. This is the command you should run on your server or hosting platform.

```bash
# Using npm script
npm start

# Using ODAC directly
npx odac start
```

**What it does:**
- Sets `NODE_ENV=production`.
- Starts the Node.js server.
- **No Overhead:** Does not run Tailwind watchers or dev tools. Simplicity and performance focused.

### Package.json Scripts

When you create a new ODAC project, your `package.json` comes pre-configured with these scripts:

```json
{
  "scripts": {
    "dev": "odac dev",
    "build": "odac build",
    "start": "odac start"
  }
}
```

- `npm run dev` - Your daily development command.
- `npm run build` - Run this before deploying (e.g., in CI/CD).
- `npm start` - The command that runs your live website.
