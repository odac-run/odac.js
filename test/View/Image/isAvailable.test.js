const Image = require('../../../src/View/Image')

describe('Image.isAvailable()', () => {
  test('should return a boolean', () => {
    // Reset memoized state by accessing the class fresh
    const result = Image.isAvailable()
    expect(typeof result).toBe('boolean')
  })

  test('should return consistent results on repeated calls', () => {
    const first = Image.isAvailable()
    const second = Image.isAvailable()
    expect(first).toBe(second)
  })
})
