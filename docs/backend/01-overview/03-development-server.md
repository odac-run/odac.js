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

### Running Behind the ODAC Proxy

On an ODAC server, the ODAC Proxy forwards visitors to your app. For apps on a bridge network the server also gives the app a private unix socket and tells it where to listen through an environment variable:

| Variable | Set by | Meaning |
|----------|--------|---------|
| `ODAC_APP` | ODAC server, automatically | `true` for every app the ODAC server runs. Decides the default `request.trustedProxies` (see below). |
| `ODAC_PROXY_SOCKET` | ODAC server, automatically | Absolute path of a unix socket (e.g. `/odac-proxy/http.sock`) the app should serve in addition to its TCP port. |

When `ODAC_PROXY_SOCKET` is set, the framework listens on that path as well as on the TCP port, with the same routes, middleware and WebSocket handling. Nothing in your app changes. The proxy prefers the socket because it skips the TCP stack between proxy and app.

- **TCP stays the fallback.** The TCP port is always opened. If the socket cannot be created (bad path, read-only directory, another process already serving it), the error is logged and the app keeps serving on TCP; the proxy falls back to TCP for any request it cannot send over the socket.
- **Stale files are handled.** A restarted container keeps the old socket file. The primary process removes it before the workers start, but only if nothing is listening on it. A symlink at the path is removed as a link and never followed; any other kind of file is left alone and the app serves TCP only.
- **Shutdown cleans up.** A graceful stop closes both listeners and removes the socket file.
- **Trust.** A connection on the socket is the ODAC Proxy by construction, so its `X-Odac-Connection-*` headers are always honoured, regardless of `request.trustedProxies`. Over TCP, an app under ODAC (`ODAC_APP=true`, also set by the server) trusts loopback and private peers by default; an app not under ODAC trusts nobody unless `trustedProxies` says so (see [Client IP behind a proxy](../06-request-and-response/01-the-request-object-what-is-the-user-asking-for.md#client-ip-behind-a-proxy)).
- **Turning it off.** Without the variable the app serves TCP only, exactly as before. Operators can disable the socket for every app on a server with `ODAC_BACKEND_SOCKETS=off` in the ODAC server's environment; the variable is then not set for apps.

You do not need to set either variable yourself. Outside an ODAC server (local development, other hosting) leave them unset.
