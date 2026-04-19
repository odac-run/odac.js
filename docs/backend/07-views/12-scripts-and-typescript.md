# 📦 Scripts & TypeScript

ODAC comes with built-in, **Zero-Config** support for frontend JavaScript and TypeScript. Write your scripts in `view/js/`, and ODAC handles transpilation, bundling, minification, and tree-shaking automatically — just like the Tailwind CSS pipeline.

## How it Works

The framework uses [esbuild](https://esbuild.github.io/) under the hood for blazing-fast builds:

1.  **Development (`npm run dev`)**:
    *   ODAC watches all `.ts`, `.js`, `.mts`, and `.mjs` files in `view/js/`.
    *   Changes trigger instant rebuilds (sub-millisecond).
    *   Source maps are enabled for easy debugging.

2.  **Production (`npm run build`)**:
    *   All entry points are bundled, minified, and tree-shaken.
    *   Output goes to `public/assets/js/{name}.js`.

3.  **Serving (`npm start`)**:
    *   The compiled JS files are served statically. No runtime overhead.

## Quick Start

Create a file at **`view/js/app.ts`** (or `app.js` for plain JavaScript):

```typescript
// view/js/app.ts
interface User {
  id: number
  name: string
}

const greet = (user: User): string => {
  return `Hello, ${user.name}!`
}

document.addEventListener('DOMContentLoaded', () => {
  console.log(greet({ id: 1, name: 'World' }))
})
```

That's it. Run `npm run dev` and ODAC compiles it to `public/assets/js/app.js`.

## Entry Points & Imports

Each file in `view/js/` becomes a separate entry point (bundle). You can use standard ES module imports between files:

```
view/js/
├── app.ts          → public/assets/js/app.js
├── admin.ts        → public/assets/js/admin.js
├── _utils.ts       (ignored — partial/import only)
└── _api.ts         (ignored — partial/import only)
```

> **Convention:** Files starting with `_` (underscore) are **not** compiled as entry points. Use them as shared modules that get imported by your entry points.

```typescript
// view/js/_api.ts (shared module — not compiled on its own)
export const fetchUsers = async (): Promise<unknown> => {
  const res = await fetch('/api/users')
  return res.json()
}
```

```typescript
// view/js/admin.ts (entry point — compiled to admin.min.js)
import { fetchUsers } from './_api'

document.addEventListener('DOMContentLoaded', async () => {
  const users = await fetchUsers()
  console.log(users)
})
```

esbuild bundles the imported code into the final output — no extra network requests.

## TypeScript or JavaScript — Your Choice

ODAC doesn't force TypeScript on you. Both work equally well:

| Extension | Behavior |
|-----------|----------|
| `.ts`     | TypeScript with full type-checking support |
| `.js`     | Plain JavaScript, passed through as-is |
| `.mts`    | TypeScript with ES module syntax |
| `.mjs`    | JavaScript with ES module syntax |

## HTML Integration

In your skeleton or layout files, reference the compiled output:

```html
<script src="/assets/js/app.js"></script>
```

The default project template already includes this in `skeleton/main.html`.

## Configuration (Optional)

ODAC works with zero configuration, but you can customize the JS pipeline in `odac.json`:

```json
{
  "js": {
    "target": "es2020",
    "minify": true,
    "sourcemap": false,
    "bundle": true,
    "obfuscate": false
  }
}
```

| Option      | Default    | Description |
|-------------|------------|-------------|
| `target`    | `"es2020"` | JavaScript target version (`es2015`, `es2020`, `esnext`, etc.) |
| `minify`    | `true`     | Enable minification in production builds |
| `sourcemap` | `false`    | Generate source maps in production (always enabled in dev) |
| `bundle`    | `true`     | Bundle imported modules into a single file |
| `obfuscate` | `false`    | Code obfuscation level (`false`, `true`/`"low"`, `"medium"`, `"high"`) |

## Obfuscation

ODAC supports three levels of code obfuscation for production builds. Obfuscation is disabled by default and only applied during `odac build` — development mode is never obfuscated.

### Levels

| Level    | What it does |
|----------|-------------|
| `false`  | No obfuscation. Standard minification only. |
| `true` / `"low"` | Mangles properties starting with `_` (private-by-convention). |
| `"medium"` | Low + drops `debugger` statements + removes `console.debug` and `console.trace`. |
| `"high"` | Maximum — mangles `_` and `$` prefixed properties, drops all `console.*` calls and `debugger` statements. |

### Example

```json
{
  "js": {
    "obfuscate": "medium"
  }
}
```

> **Tip:** Start with `"low"` or `"medium"`. The `"high"` level mangles `$`-prefixed properties which may break code that interacts with external libraries using `$` conventions (e.g., jQuery, some frameworks). Test thoroughly before deploying with `"high"`.

## What You Get

- **TypeScript Support** — Write type-safe frontend code without any setup
- **Bundling** — `import`/`export` between files, everything merged into one output
- **Minification** — Whitespace removal, variable shortening, dead code elimination
- **Tree-Shaking** — Unused exports are automatically removed
- **Obfuscation** — Optional property mangling and console stripping (3 levels)
- **Source Maps** — Enabled in development for easy debugging
- **Multiple Entry Points** — Separate bundles for different pages/sections
- **Sub-millisecond Rebuilds** — esbuild's native speed keeps your dev loop instant
