## 🖼️ Image Optimization

ODAC provides automatic image optimization through the `<odac:img>` tag. Images are resized, converted to modern formats (WebP, AVIF), and cached — all on-demand, with zero configuration required.

> **Note:** Image optimization requires the `sharp` package. Install it with `npm install sharp`. Without it, `<odac:img>` gracefully falls back to a standard `<img>` tag with no processing.

### Basic Usage

The simplest usage — just provide a `src`. ODAC automatically converts the image to WebP:

```html
<odac:img src="/images/hero.jpg" />
```

This is equivalent to writing:

```html
<img src="/_odac/img/hero-o-a1b2c3d4.webp">
```

The processed image is cached after the first request. All subsequent requests are served instantly.

### Resize

Specify `width` and/or `height` to resize the image. Aspect ratio is always preserved — the image will never be stretched or enlarged beyond its original size:

```html
<!-- Resize by width only -->
<odac:img src="/images/hero.jpg" width="800" />

<!-- Resize by both dimensions (fits inside the box) -->
<odac:img src="/images/hero.jpg" width="800" height="600" />

<!-- Thumbnail -->
<odac:img src="/images/product.jpg" width="200" height="200" />
```

### Format Conversion

Convert to any modern format using the `format` attribute:

```html
<!-- WebP (default) -->
<odac:img src="/images/photo.png" format="webp" />

<!-- AVIF (best compression, newer browsers) -->
<odac:img src="/images/photo.png" format="avif" />

<!-- Keep as PNG -->
<odac:img src="/images/logo.png" format="png" />
```

**Supported formats:** `webp`, `avif`, `png`, `jpeg`, `tiff`

### Quality

Control the compression quality with the `quality` attribute (1–100, default: 80):

```html
<!-- High quality for hero images -->
<odac:img src="/images/banner.jpg" width="1200" quality="90" />

<!-- Lower quality for thumbnails (smaller file size) -->
<odac:img src="/images/thumb.jpg" width="100" quality="60" />
```

### Standard HTML Attributes

All standard `<img>` attributes are passed through as-is:

```html
<odac:img
  src="/images/avatar.jpg"
  width="64"
  height="64"
  alt="User avatar"
  class="rounded-full"
  loading="lazy"
  decoding="async"
/>
```

### Dynamic Source

Use template variables for dynamic image sources:

```html
<!-- From controller data -->
<odac:img src="{{ product.image }}" width="300" height="300" alt="{{ product.name }}" />

<!-- In a loop -->
<odac:for in="products" value="product">
  <odac:img src="{{ product.thumbnail }}" width="200" alt="{{ product.name }}" />
</odac:for>
```

### Practical Examples

#### Product Card

```html
<div class="product-card">
  <odac:img
    src="{{ product.image }}"
    width="400"
    height="300"
    alt="{{ product.name }}"
    class="product-image"
    loading="lazy"
  />
  <h3><odac var="product.name" /></h3>
  <p>$<odac var="product.price" /></p>
</div>
```

#### Hero Banner

```html
<section class="hero">
  <odac:img
    src="/images/hero.jpg"
    width="1920"
    height="600"
    alt="Hero banner"
    class="hero-image"
    quality="90"
  />
</section>
```

#### Avatar with Fallback

```html
<odac:if condition="user.avatar">
  <odac:img src="{{ user.avatar }}" width="64" height="64" alt="Avatar" class="avatar" />
<odac:else>
  <img src="/images/default-avatar.png" width="64" height="64" alt="Default avatar" class="avatar">
</odac:if>
```

#### Image Gallery

```html
<div class="gallery">
  <odac:for in="photos" value="photo">
    <a href="{{ photo.url }}">
      <odac:img
        src="{{ photo.url }}"
        width="400"
        height="300"
        alt="{{ photo.caption }}"
        class="gallery-thumb"
        loading="lazy"
      />
    </a>
  </odac:for>
</div>
```

### Configuration

You can override the defaults in `odac.json`:

```json
{
  "image": {
    "format": "webp",
    "quality": 80,
    "maxDimension": 4096
  }
}
```

| Option | Default | Description |
|--------|---------|-------------|
| `format` | `webp` | Default output format when `format` is not specified in the tag |
| `quality` | `80` | Default compression quality (1–100) |
| `maxDimension` | `4096` | Maximum allowed width or height in pixels |

### How It Works

1. The `<odac:img>` tag is compiled at template render time.
2. ODAC checks the source file's modification time (`mtime`) and includes it in the hash. This means when you update a source image, the URL automatically changes — no manual cache busting needed.
3. On the first request, ODAC processes the source image using `sharp` and saves the result to `storage/.cache/img/`.
4. The `<img>` tag in the HTML points to `/_odac/img/{name}-{dimension}-{hash}.{ext}` — an internal route that serves the cached file. The filename includes the original image name and dimension for easy debugging.
5. All subsequent requests hit the cache directly, with `Cache-Control: immutable` headers for maximum browser caching.

> **Cache Busting:** You don't need to rename files or add query strings. Simply replace the source image in `public/` and the next page render will produce a new URL with a different hash, forcing browsers and CDNs to fetch the updated version.

### Best Practices

- Always set `alt` for accessibility.
- Use `loading="lazy"` for below-the-fold images to improve page load performance.
- Set explicit `width` and `height` to prevent layout shift (CLS).
- Keep original high-resolution images in `public/` — let ODAC handle the downsizing.
- Use `avif` for the best compression ratio on modern browsers; use `webp` for broader compatibility.
- For programmatic URL access in controllers (JSON APIs, CSS backgrounds, emails), see [`Odac.image()`](../05-controllers/02-your-trusty-odac-assistant.md#image-processing).
