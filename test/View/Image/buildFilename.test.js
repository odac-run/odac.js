const Image = require('../../../src/View/Image')

describe('Image.buildFilename()', () => {
  test('should produce {name}-{width}-{hash}.{ext} format with width', () => {
    const result = Image.buildFilename('/images/logo.jpg', {width: 250, format: 'webp'})
    expect(result).toMatch(/^logo-250-[a-f0-9]{8}\.webp$/)
  })

  test('should use "o" for dimension when no width specified', () => {
    const result = Image.buildFilename('/images/hero.png', {format: 'avif'})
    expect(result).toMatch(/^hero-o-[a-f0-9]{8}\.avif$/)
  })

  test('should fall back to source extension when no format specified', () => {
    const result = Image.buildFilename('/images/photo.png', {width: 800})
    expect(result).toMatch(/^photo-800-[a-f0-9]{8}\.png$/)
  })

  test('should sanitize special characters in basename', () => {
    const result = Image.buildFilename('/images/my photo (1).jpg', {width: 100, format: 'webp'})
    expect(result).not.toContain(' ')
    expect(result).not.toContain('(')
    expect(result).toMatch(/^my_photo__1_-100-[a-f0-9]{8}\.webp$/)
  })

  test('should produce different filenames for same name in different directories', () => {
    const a = Image.buildFilename('/images/blog/logo.jpg', {width: 250, format: 'webp'})
    const b = Image.buildFilename('/images/brand/logo.jpg', {width: 250, format: 'webp'})
    // Same basename but different hash due to different full src path
    expect(a).not.toBe(b)
    expect(a).toMatch(/^logo-250-/)
    expect(b).toMatch(/^logo-250-/)
  })

  test('should produce different filenames for same file with different quality', () => {
    const a = Image.buildFilename('/images/logo.jpg', {width: 250, quality: 80, format: 'webp'})
    const b = Image.buildFilename('/images/logo.jpg', {width: 250, quality: 50, format: 'webp'})
    expect(a).not.toBe(b)
  })

  test('should be deterministic for identical inputs', () => {
    const opts = {width: 300, format: 'webp', quality: 80}
    const a = Image.buildFilename('/images/hero.jpg', opts)
    const b = Image.buildFilename('/images/hero.jpg', opts)
    expect(a).toBe(b)
  })

  test('should handle nested paths correctly', () => {
    const result = Image.buildFilename('/uploads/2024/03/cover.png', {width: 600, format: 'webp'})
    expect(result).toMatch(/^cover-600-[a-f0-9]{8}\.webp$/)
  })

  test('should produce different filenames when mtime changes', () => {
    const opts = {width: 250, format: 'webp'}
    const a = Image.buildFilename('/images/logo.jpg', opts, 1000000)
    const b = Image.buildFilename('/images/logo.jpg', opts, 2000000)
    expect(a).not.toBe(b)
    // Both should have same prefix, different hash
    expect(a).toMatch(/^logo-250-/)
    expect(b).toMatch(/^logo-250-/)
  })
})
