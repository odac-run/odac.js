---
name: backend-image-processing-skill
description: ODAC on-demand image optimization via the odac:img template tag with automatic resize, format conversion, and aggressive caching.
metadata:
  tags: backend, image, optimization, sharp, webp, resize, template, view
---

# Backend Image Processing Skill

ODAC provides on-demand image processing through the `<odac:img>` template tag. Images are automatically resized, converted to modern formats (WebP, AVIF), and cached to disk for sub-millisecond subsequent responses.

## Architectural Approach

Processing happens at render time via `src/View/Image.js`. The first request triggers sharp-based transformation; all subsequent requests serve from `storage/.cache/img/`. Sharp is an optional dependency — when absent, `<odac:img>` gracefully degrades to a standard `<img>` tag.

## Core Rules

1. **Optional Dependency**: Sharp must be installed separately (`npm install sharp`). The framework functions without it.
2. **Security**: Path traversal is blocked. Only files under `public/` are processable.
3. **Cache**: Processed images are stored in `storage/.cache/img/` with human-readable filenames (`{name}-{dimension}-{hash}.{ext}`) for easy debugging and CDN log analysis.
4. **Max Dimension**: 4096px cap prevents resource exhaustion from oversized requests.

## Reference Patterns

### 1. Basic Resize + Format Conversion
```html
<odac:img src="/images/hero.jpg" width="800" height="600" format="webp"/>
```

### 2. Format Conversion Only (No Resize)
```html
<odac:img src="/images/logo.png" format="webp"/>
```

### 3. Custom Quality
```html
<odac:img src="/images/banner.jpg" width="1200" format="webp" quality="90"/>
```

### 4. Dynamic Source from Controller
```html
<odac:img src="{{ product.image }}" width="200" height="200" format="webp" alt="Product"/>
```

### 5. With Standard HTML Attributes
```html
<odac:img src="/images/avatar.jpg" width="64" height="64" format="webp"
          alt="User avatar" class="rounded-full" loading="lazy" decoding="async"/>
```

## Supported Attributes

| Attribute | Type | Description |
|-----------|------|-------------|
| `src` | string | Source path relative to `public/` (required) |
| `width` | number | Target width in pixels |
| `height` | number | Target height in pixels |
| `format` | string | Output format: `webp`, `avif`, `png`, `jpeg`, `tiff` |
| `quality` | number | Compression quality 1-100 (default: 80) |
| All others | — | Passed through to the `<img>` tag as-is |

## Configuration

Default settings in `odac.json`:
```json
{
  "image": {
    "quality": 80,
    "maxDimension": 4096,
    "format": "webp"
  }
}
```

## Best Practices

- Prefer `webp` format for the best size/quality ratio across modern browsers.
- Set explicit `width` and `height` to prevent layout shift (CLS).
- Use `loading="lazy"` for below-the-fold images.
- Keep source images at high resolution in `public/`; let ODAC handle the downsizing.

## Programmatic API (`Odac.image()`)

For cases where a raw URL is needed instead of an `<img>` tag (div backgrounds, JSON APIs, mail templates, cron jobs):

```js
const url = await Odac.image('/images/hero.jpg', { width: 800, format: 'webp' })
// → "/_odac/img/hero-800-a1b2c3d4.webp"
```

- Available on every `Odac` instance (controller, cron, middleware).
- Same processing pipeline and cache as `<odac:img>`.
- Returns original `src` as fallback when sharp is unavailable.
