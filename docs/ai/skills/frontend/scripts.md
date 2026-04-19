---
name: frontend-scripts-typescript-skill
description: ODAC frontend JS/TS pipeline guidelines for writing, bundling, and optimizing client-side scripts using esbuild.
metadata:
  tags: frontend, javascript, typescript, esbuild, bundling, minification, tree-shaking, scripts, assets
---

# Frontend Scripts & TypeScript Skill

Zero-config frontend asset pipeline powered by esbuild for TypeScript transpilation, bundling, minification, and tree-shaking.

## Core Rules
1.  **Entry Points**: Place `.ts`, `.js`, `.mts`, or `.mjs` files in `view/js/`. Each becomes a separate bundle.
2.  **Partials Convention**: Files starting with `_` (e.g., `_utils.ts`) are ignored as entry points — use them as shared imports only.
3.  **Output Path**: Compiled files go to `public/assets/js/{name}.js`.
4.  **No TypeScript Enforcement**: Both TypeScript and plain JavaScript are supported equally.
5.  **Import Resolution**: Use standard ES module `import`/`export` between files. esbuild bundles everything into a single output per entry point.
6.  **Configuration**: Optional `js` key in `odac.json` for `target`, `minify`, `sourcemap`, and `bundle` settings.

## Development vs Production
- **`odac dev`**: Watch mode with source maps, no minification, instant rebuilds.
- **`odac build`**: Full minification, tree-shaking, and dead code elimination.

## Example Structure
```
view/js/
├── app.ts          → public/assets/js/app.min.js
├── admin.ts        → public/assets/js/admin.min.js
├── _api.ts         (shared module, not compiled)
└── _utils.ts       (shared module, not compiled)
```

## HTML Integration
```html
<script src="/assets/js/app.min.js"></script>
```
