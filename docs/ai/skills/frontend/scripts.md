---
name: frontend-scripts-typescript-skill
description: ODAC frontend JS/TS pipeline guidelines for writing, bundling, and optimizing client-side scripts using esbuild and code obfuscation.
metadata:
  tags: frontend, javascript, typescript, esbuild, bundling, minification, tree-shaking, scripts, assets, obfuscation
---

# Frontend Scripts & TypeScript Skill

ODAC provides a built-in, Zero-Config frontend asset pipeline powered by **esbuild** for TypeScript transpilation, bundling, minification, tree-shaking, and multi-level code obfuscation.

## Core Rules & Conventions

1.  **Entry Points**: Every `.ts`, `.js`, `.mts`, or `.mjs` file placed directly in `view/js/` represents a unique entry point and will compile into a separate bundle in `public/assets/js/{name}.js`.
2.  **Partials Convention**: Files starting with an underscore (e.g., `_utils.ts`, `_api.ts`) are treated as private modules/partials. They are **ignored** as entry points and should only be used as shared imports.
3.  **No TypeScript Enforcement**: TypeScript and plain JavaScript are supported equally out of the box.
4.  **Import Resolution**: Use standard ES module `import`/`export` syntax. esbuild bundles all imported modules into a single optimized bundle, eliminating extra runtime network requests.
5.  **Output Path**: Compiled output is saved statically under `public/assets/js/`.

## Pipeline Modes

*   **Development (`npm run dev` / `odac dev`)**: 
    *   Watches all scripts in `view/js/` for instant sub-millisecond rebuilds.
    *   Source maps are always enabled to facilitate easy debugging.
    *   No minification or obfuscation is applied.
*   **Production (`npm run build` / `odac build`)**:
    *   Enables full bundling, minification, and tree-shaking.
    *   Applies configured obfuscation levels.
    *   Exports clean production-ready assets to `public/assets/js/`.

## Configuration (`odac.json`)

You can customize the pipeline behavior via the optional `js` key in the `odac.json` configuration file:

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

### Configuration Options

| Option      | Default    | Description |
|-------------|------------|-------------|
| `target`    | `"es2020"` | JavaScript target version (`es2015`, `es2020`, `esnext`, etc.). |
| `minify`    | `true`     | Enables minification (whitespace removal, variable shortening, dead code elimination) in production. |
| `sourcemap` | `false`    | Generates source maps in production builds (always enabled in dev mode). |
| `bundle`    | `true`     | Bundles all imported dependency modules into the output entry-point file. |
| `obfuscate` | `false`    | Configures the level of production code obfuscation (`false`, `true`/`"low"`, `"medium"`, `"high"`). |

---

## Obfuscation Levels

ODAC supports three distinct levels of code obfuscation in production mode (`odac build`). Obfuscation is disabled by default and is never applied during development.

| Level | Behavior |
|-------|----------|
| `false` | **No Obfuscation**: Standard minification and tree-shaking only. |
| `true` / `"low"` | **Low Mangling**: Mangles properties starting with `_` (private-by-convention). |
| `"medium"` | **Medium Security**: Low level mangling + drops `debugger` statements + removes `console.debug` and `console.trace` calls. |
| `"high"` | **Maximum Hardening**: Mangles all `_` and `$` prefixed properties + drops all `console.*` calls and `debugger` statements. |

> [!WARNING]
> **High Obfuscation Compatibility Warning:** 
> The `"high"` obfuscation level mangles `$`-prefixed properties. This can break frontend code interacting with external libraries or frameworks that rely heavily on the `$` naming convention (e.g., jQuery). Start with `"low"` or `"medium"` and verify compatibility thoroughly before deploying with `"high"`.

---

## Example Directory Structure

```
view/js/
├── app.ts          → compiled to public/assets/js/app.js (Entry Point)
├── admin.ts        → compiled to public/assets/js/admin.js (Entry Point)
├── _api.ts         (Shared API Module — Import only, not compiled on its own)
└── _utils.ts       (Shared Utility Module — Import only, not compiled on its own)
```

## HTML Integration

Inject compiled scripts into your skeleton or layout templates using regular script tags:

```html
<script src="/assets/js/app.js"></script>
```
