# 🎨 Styling & Tailwind CSS

Odac comes with built-in, **Zero-Config** support for Tailwind CSS v4. This means you can start building beautiful, modern interfaces right out of the box without messing with configuration files or build pipelines.

## How it Works

The framework adopts a "Convention over Configuration" approach:

1.  **Development (`npm run dev`)**:
    *   The framework automatically watches your HTML, JS, and View files.
    *   It compiles your CSS classes using the high-performance Rust-based Tailwind CLI.
    *   Changes are reflected instantly.

2.  **Production (`npm run build`)**:
    *   The framework scans your project, builds the final CSS, and minifies it.
    *   The output is saved to `public/assets/css/app.css`.

3.  **Serving (`npm start`)**:
    *   The compiled CSS file is served statically. No background processes, no overhead.

## Customizing CSS

By default, Odac manages everything for you internally. However, if you need to add custom CSS, fonts, or Tailwind configuration (like `@theme`), you can do so easily.

### The Source File

Simply create a file at **`view/css/app.css`**.

If this file exists, Odac will use it as the **source** (input) for Tailwind.

**Example `view/css/app.css`:**

```css
@import "tailwindcss";

@theme {
  --font-display: "Satoshi", "sans-serif";
  --color-brand: #ff5733;
}

/* Your custom CSS rules */
.hero-gradient {
  background: linear-gradient(to right, var(--color-brand), #ff0000);
}
```

### The Output File

The compiled CSS is always output to:
**`public/assets/css/app.css`**

> **⚠️ Important:** Never edit `public/assets/css/app.css` manually. It is a generated file and will be overwritten by Odac during build or development. Always edit `view/css/app.css` instead.

## HTML Integration

In your layout files (e.g., `view/head/main.html`), simply link to the compiled asset:

```html
<link rel="stylesheet" href="/assets/css/app.css" />
```

This is already set up for you in the default project template.

## Multiple CSS Files

Odac supports multiple CSS entry points. If your application has distinct sections (e.g., a Landing Page, a Dashboard, and an Admin Panel) that require separate stylesheets, you can organize them easily.

### How to use

Any `.css` file you place in the **`view/css/`** directory will be automatically detected, watched, and compiled by Odac.

**Input:**
*   `view/css/app.css`
*   `view/css/admin.css`
*   `view/css/landing.css`

**Output (Compiled):**
*   `public/assets/css/app.css`
*   `public/assets/css/admin.css`
*   `public/assets/css/landing.css`

You can then link each specific stylesheet in its respective layout file:

```html
<!-- In Admin Layout -->
<link rel="stylesheet" href="/assets/css/admin.css" />
```

## Using Tailwind v4

Tailwind v4 is radically simpler. You generally don't need a `tailwind.config.js` file anymore. You can define your theme directly in CSS using the `@theme` block as shown above.

However, Odac respects standard Tailwind behavior. If you absolutely need a config file for plugins or legacy reasons, you can create one, and the Tailwind CLI will detect it. But for 99% of use cases, the Zero-Config approach is cleaner and faster.
