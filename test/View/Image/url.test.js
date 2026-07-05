const fs = require('fs')
const fsPromises = fs.promises
const os = require('os')
const path = require('path')
const Image = require('../../../src/View/Image')

describe('Image.url()', () => {
  let tmpDir, testImagePath

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'odac-image-url-'))
    global.__dir = tmpDir

    const testImageDir = path.join(tmpDir, 'public', 'images')
    testImagePath = path.join(testImageDir, 'url-test.jpg')

    await fsPromises.mkdir(testImageDir, {recursive: true})
    await fsPromises.writeFile(testImagePath, Buffer.from('fake-jpg-data'))
  })

  afterAll(async () => {
    delete global.__dir
    await fsPromises.rm(tmpDir, {recursive: true, force: true})
  })

  test('should return empty string for empty src', async () => {
    const result = await Image.url('')
    expect(result).toBe('')
  })

  test('should return empty string for null/undefined src', async () => {
    expect(await Image.url(null)).toBe('')
    expect(await Image.url(undefined)).toBe('')
  })

  test('should return original src when sharp is unavailable', async () => {
    // sharp is not installed in test env
    const result = await Image.url('/images/url-test.jpg')
    expect(result).toBe('/images/url-test.jpg')
  })

  test('should return original src when source file does not exist', async () => {
    // Force isAvailable to true temporarily to test file-not-found path
    const original = Image.isAvailable
    Image.isAvailable = () => true

    const result = await Image.url('/images/nonexistent.jpg')
    expect(result).toBe('/images/nonexistent.jpg')

    Image.isAvailable = original
  })

  test('should accept options parameter without error', async () => {
    const result = await Image.url('/images/url-test.jpg', {width: 300, format: 'webp', quality: 80})
    // Returns original src since sharp is unavailable in test
    expect(typeof result).toBe('string')
    expect(result.length).toBeGreaterThan(0)
  })
})
