const Image = require('../../../src/View/Image')

describe('Image.hash()', () => {
  test('should produce an 8-character hex string', () => {
    const result = Image.hash('/images/hero.jpg', {width: 400, height: 300})
    expect(result).toMatch(/^[a-f0-9]{8}$/)
  })

  test('should be deterministic for identical inputs', () => {
    const options = {width: 800, format: 'webp', quality: 80}
    const a = Image.hash('/images/photo.png', options)
    const b = Image.hash('/images/photo.png', options)
    expect(a).toBe(b)
  })

  test('should produce different hashes for different sources', () => {
    const options = {width: 400}
    const a = Image.hash('/images/a.jpg', options)
    const b = Image.hash('/images/b.jpg', options)
    expect(a).not.toBe(b)
  })

  test('should produce different hashes for different dimensions', () => {
    const a = Image.hash('/images/hero.jpg', {width: 400})
    const b = Image.hash('/images/hero.jpg', {width: 800})
    expect(a).not.toBe(b)
  })

  test('should produce different hashes for different formats', () => {
    const a = Image.hash('/images/hero.jpg', {format: 'webp'})
    const b = Image.hash('/images/hero.jpg', {format: 'avif'})
    expect(a).not.toBe(b)
  })

  test('should produce different hashes for different quality values', () => {
    const a = Image.hash('/images/hero.jpg', {quality: 80})
    const b = Image.hash('/images/hero.jpg', {quality: 50})
    expect(a).not.toBe(b)
  })

  test('should handle empty options gracefully', () => {
    const result = Image.hash('/images/hero.jpg')
    expect(result).toMatch(/^[a-f0-9]{8}$/)
  })

  test('should produce different hashes when mtime changes', () => {
    const opts = {width: 400, format: 'webp'}
    const a = Image.hash('/images/hero.jpg', opts, 1000000)
    const b = Image.hash('/images/hero.jpg', opts, 2000000)
    expect(a).not.toBe(b)
  })

  test('should produce same hash for same mtime', () => {
    const opts = {width: 400, format: 'webp'}
    const a = Image.hash('/images/hero.jpg', opts, 1000000)
    const b = Image.hash('/images/hero.jpg', opts, 1000000)
    expect(a).toBe(b)
  })
})
