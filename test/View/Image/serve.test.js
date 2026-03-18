const fs = require('fs')
const fsPromises = fs.promises
const path = require('path')

// Guard against coverage-instrumented Request.js requiring global.Odac
// when this test runs in parallel with other suites that set/unset global.Odac.
if (!global.Odac) global.Odac = {Route: {routes: {}}}

const Image = require('../../../src/View/Image')

const IMG_CACHE_DIR = './storage/.cache/img'

describe('Image.serve()', () => {
  const testFilename = 'testserve1234567.webp'
  const testFilePath = path.join(IMG_CACHE_DIR, testFilename)

  beforeAll(async () => {
    await fsPromises.mkdir(IMG_CACHE_DIR, {recursive: true})
    await fsPromises.writeFile(testFilePath, Buffer.from('fake-image-data'))
  })

  afterAll(async () => {
    await fsPromises.unlink(testFilePath).catch(() => {})
  })

  test('should return stream, type, and size for a cached file', async () => {
    const result = await Image.serve(testFilename)

    expect(result).not.toBeNull()
    expect(result.type).toBe('image/webp')
    expect(result.size).toBe(Buffer.from('fake-image-data').length)
    expect(typeof result.stream.pipe).toBe('function')

    result.stream.destroy()
  })

  test('should return null for non-existent files', async () => {
    const result = await Image.serve('nonexistent00000.webp')
    expect(result).toBeNull()
  })

  test('should block path traversal attempts', async () => {
    const result = await Image.serve('../../../etc/passwd')
    expect(result).toBeNull()
  })

  test('should resolve jpg extension to image/jpeg MIME type', async () => {
    const jpgFilename = 'testservejpg0000.jpg'
    const jpgPath = path.join(IMG_CACHE_DIR, jpgFilename)
    await fsPromises.writeFile(jpgPath, Buffer.from('fake-jpg'))

    const result = await Image.serve(jpgFilename)
    expect(result).not.toBeNull()
    expect(result.type).toBe('image/jpeg')
    result.stream.destroy()

    await fsPromises.unlink(jpgPath).catch(() => {})
  })
})
