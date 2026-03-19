const Image = require('../../../src/View/Image')

describe('Image.process()', () => {
  test('should return null when sharp is unavailable', async () => {
    const originalIsAvailable = Image.isAvailable
    Image.isAvailable = () => false

    try {
      const result = await Image.process('/images/hero.jpg', {width: 400})
      expect(result).toBeNull()
    } finally {
      Image.isAvailable = originalIsAvailable
    }
  })

  test('should return null for unsupported source extensions', async () => {
    if (!Image.isAvailable()) return

    const result = await Image.process('/images/document.pdf', {width: 400})
    expect(result).toBeNull()
  })

  test('should return null for non-existent source files', async () => {
    if (!Image.isAvailable()) return

    global.__dir = process.cwd()
    const result = await Image.process('/nonexistent/image.jpg', {width: 400})
    expect(result).toBeNull()
  })

  test('should return null for path traversal attempts', async () => {
    if (!Image.isAvailable()) return

    global.__dir = process.cwd()
    const result = await Image.process('/../../../etc/passwd', {width: 400})
    expect(result).toBeNull()
  })
})
