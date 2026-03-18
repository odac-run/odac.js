const Image = require('../../../src/View/Image')

describe('Image.render()', () => {
  test('should return a standard <img> tag when sharp is unavailable', async () => {
    const originalIsAvailable = Image.isAvailable
    Image.isAvailable = () => false

    try {
      const html = await Image.render({
        src: '/images/hero.jpg',
        width: '400',
        height: '300',
        alt: 'Hero image',
        class: 'rounded'
      })

      expect(html).toContain('<img src="/images/hero.jpg"')
      expect(html).toContain('alt="Hero image"')
      expect(html).toContain('class="rounded"')
      expect(html).toContain('height="300"')
      expect(html).toContain('width="400"')
      expect(html).not.toContain('format=')
      expect(html).not.toContain('quality=')
      expect(html).toMatch(/>$/)
    } finally {
      Image.isAvailable = originalIsAvailable
    }
  })

  test('should exclude processing attributes (format, quality) from HTML output', async () => {
    const originalIsAvailable = Image.isAvailable
    Image.isAvailable = () => false

    try {
      const html = await Image.render({
        src: '/images/photo.png',
        width: '800',
        format: 'webp',
        quality: '90',
        alt: 'Photo'
      })

      expect(html).not.toContain('format=')
      expect(html).not.toContain('quality=')
      expect(html).toContain('alt="Photo"')
    } finally {
      Image.isAvailable = originalIsAvailable
    }
  })

  test('should return fallback <img> when src is empty', async () => {
    const html = await Image.render({src: '', alt: 'Empty'})
    expect(html).toContain('<img src=""')
    expect(html).toContain('alt="Empty"')
  })

  test('should render boolean attributes without value', async () => {
    const originalIsAvailable = Image.isAvailable
    Image.isAvailable = () => false

    try {
      const html = await Image.render({
        src: '/images/hero.jpg',
        loading: 'lazy',
        decoding: 'async'
      })

      expect(html).toContain('loading="lazy"')
      expect(html).toContain('decoding="async"')
    } finally {
      Image.isAvailable = originalIsAvailable
    }
  })

  test('should output HTML attributes in alphabetical order', async () => {
    const originalIsAvailable = Image.isAvailable
    Image.isAvailable = () => false

    try {
      const html = await Image.render({
        src: '/images/hero.jpg',
        width: '400',
        alt: 'Test',
        class: 'img'
      })

      const altPos = html.indexOf('alt=')
      const classPos = html.indexOf('class=')
      const widthPos = html.indexOf('width=')

      expect(altPos).toBeLessThan(classPos)
      expect(classPos).toBeLessThan(widthPos)
    } finally {
      Image.isAvailable = originalIsAvailable
    }
  })

  test('should escape HTML special characters in attribute values to prevent XSS', async () => {
    const originalIsAvailable = Image.isAvailable
    Image.isAvailable = () => false

    try {
      const html = await Image.render({
        src: '/img.jpg" onload="alert(1)',
        alt: '<script>xss</script>'
      })

      // Quotes are escaped so the injected onload never becomes a real attribute
      expect(html).toContain('&quot; onload=&quot;')
      expect(html).not.toContain('<script>')
      expect(html).toContain('&quot;')
      expect(html).toContain('&lt;script&gt;')
    } finally {
      Image.isAvailable = originalIsAvailable
    }
  })
})
