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
- **Hot reload:** Routes, controllers, classes, middleware and hooks are reloaded as soon as you save them, without a restart.
- **Live reload:** Open browser tabs update themselves when you save (see below).

### Live Reload in the Browser

In debug mode (any run where `NODE_ENV` is not `production`), every page rendered from a skeleton listens for your saves and updates itself. Nothing needs to be configured. The page does the least it has to:

| You save | The open page |
|----------|---------------|
| A stylesheet (Tailwind output in `public/**/*.css`) | Swaps the stylesheet in place. No reload; scroll, form input and state stay. |
| A part's view (`view/content/…`, `view/header/…`, …) | Re-renders **only that part** through AJAX navigation. Other parts stay untouched. |
| A shared view (`view/components/…`, a file directly in `view/`) | Re-renders every part of the page. |
| A route, controller, class, middleware or hook | Reloads the code on the server first, then re-renders every part. |
| A skeleton (`skeleton/…`) | Reloads the page. |
| A compiled script (`public/**/*.js`) or another public file | Reloads the page. |

Part refreshes keep the scroll position and do not add a history entry. `Odac.action({load})` and `page` handlers run again after a refresh, as they do after every navigation, so write them to run more than once. A page without navigable parts reloads instead. If the server restarts, open tabs reload once it is back.

`view/css/`, `view/js/` and `view/mail/` are not watched directly: their compiled output in `public/` is (mail templates are not shown in pages). Saved language files appear on the next navigation.

**How it works:** the server watches the project with `fs.watch` and pushes each change to open tabs over a Server-Sent Events stream at `/_odac/dev`. Bursts of saves within 100 ms become one update. Only part names and public stylesheet URLs are sent, never server file paths. The stream and the `data-odac-dev` marker on `<html>` exist only in debug mode; production (`odac start`) has neither, and the route is not registered.

Where `fs.watch` reports nothing (some network or VM mounts), the server still picks up code changes within 5 seconds, but the browser is not notified; refresh it yourself.

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
| `ODAC_PROXY_KEY` | ODAC server, automatically | Secret the proxy signs `X-Odac-Connection-*` with, so the app can tell the proxy from anything else reaching its TCP port. |

When `ODAC_PROXY_SOCKET` is set, the framework listens on that path as well as on the TCP port, with the same routes, middleware and WebSocket handling. Nothing in your app changes. The proxy prefers the socket because it skips the TCP stack between proxy and app.

- **TCP stays the fallback.** The TCP port is always opened. If the socket cannot be created (bad path, read-only directory, another process already serving it), the error is logged and the app keeps serving on TCP; the proxy falls back to TCP for any request it cannot send over the socket.
- **You can see it.** When the socket is up on an ODAC server, the app prints `⚡ Turbo Mode ODAC Proxy → unix socket, TCP stack bypassed.` once at startup. No banner means the app is serving TCP only.
- **Stale files are handled.** A restarted container keeps the old socket file. The primary process removes it before the workers start, but only if nothing is listening on it. A symlink at the path is removed as a link and never followed; any other kind of file is left alone and the app serves TCP only.
- **Shutdown cleans up.** A graceful stop closes both listeners and removes the socket file. A socket that still answers once every worker has stopped belongs to another process (for example, a new instance already serving the same path) and is left alone.
- **Trust.** A connection on the socket is the ODAC Proxy by construction, so its `X-Odac-Connection-*` headers are always honoured, regardless of `request.trustedProxies`. Over TCP they are honoured when the proxy's signature checks out against `ODAC_PROXY_KEY`; an app with no key falls back to trusting private peers under ODAC and nobody otherwise (see [Client IP behind a proxy](../06-request-and-response/01-the-request-object-what-is-the-user-asking-for.md#client-ip-behind-a-proxy)).
- **Turning it off.** Without the variable the app serves TCP only, exactly as before. Operators can disable the socket for every app on a server with `ODAC_BACKEND_SOCKETS=off` in the ODAC server's environment; the variable is then not set for apps.

You do not need to set any of these variables yourself. Outside an ODAC server (local development, other hosting) leave them unset.
