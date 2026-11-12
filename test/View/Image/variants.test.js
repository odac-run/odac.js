const fs = require('fs')
const os = require('os')
const path = require('path')
const Image = require('../../../src/View/Image')

// Superseded variants are retired when a newer source version is processed and deleted by
// sweepRetired() once RETIRED_GRACE has passed. Production re-checks source mtimes every
// MTIME_TTL instead of caching them until restart.

const sharpAvailable = Image.isAvailable()
const maybe = sharpAvailable ? describe : describe.skip

maybe('Image variant lifecycle', () => {
  let dir
  let sharp

  const cacheDir = () => path.join(dir, 'storage/.cache/img')
  const variants = () => fs.readdirSync(cacheDir()).filter(f => !f.startsWith('.'))

  async function writeSource(color, mtimeSeconds) {
    const file = path.join(dir, 'public/images/logo.png')
    fs.mkdirSync(path.dirname(file), {recursive: true})
    await sharp({create: {width: 20, height: 20, channels: 3, background: color}})
      .png()
      .toFile(file)
    const time = new Date(mtimeSeconds * 1000)
    fs.utimesSync(file, time, time)
  }

  beforeAll(() => {
    sharp = require('sharp')
  })

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'odac-img-'))
    global.__dir = dir
    global.Odac = {Config: {debug: true}}
    Image.clearCache()
  })

  afterEach(() => {
    fs.rmSync(dir, {recursive: true, force: true})
    delete global.__dir
    delete global.Odac
    jest.restoreAllMocks()
  })

  it('retires the previous variant and deletes it after the grace period', async () => {
    await writeSource('red', 1_700_000_000)
    const first = await Image.url('/images/logo.png', {width: 10, format: 'webp'})
    await writeSource('blue', 1_700_000_100)
    const second = await Image.url('/images/logo.png', {width: 10, format: 'webp'})

    expect(first).not.toBe(second)
    expect(variants().sort()).toEqual([path.basename(first), path.basename(second)].sort())

    await expect(Image.sweepRetired(Date.now())).resolves.toBe(0)
    expect(variants()).toHaveLength(2)

    await expect(Image.sweepRetired(Date.now() + Image.RETIRED_GRACE + 1)).resolves.toBe(1)
    expect(variants()).toEqual([path.basename(second)])
  })

  it('never retires the current variant for an older source version', async () => {
    await writeSource('red', 1_700_000_100)
    const current = await Image.process('/images/logo.png', {width: 10, format: 'webp'}, 1_700_000_100_000)
    const stale = await Image.process('/images/logo.png', {width: 10, format: 'webp'}, 1_700_000_000_000)

    await Image.sweepRetired(Date.now() + Image.RETIRED_GRACE + 1)
    expect(variants()).toContain(current.cacheKey)
    expect(variants()).toContain(stale.cacheKey)
  })

  it('leaves no temporary files behind', async () => {
    await writeSource('red', 1_700_000_000)
    await Image.url('/images/logo.png', {width: 10, format: 'webp'})
    const all = fs.readdirSync(cacheDir(), {recursive: true})
    expect(all.some(f => String(f).endsWith('.tmp'))).toBe(false)
  })

  it('picks up a replaced source in production after MTIME_TTL', async () => {
    global.Odac.Config.debug = false
    await writeSource('red', 1_700_000_000)
    const first = await Image.url('/images/logo.png', {width: 10, format: 'webp'})
    await writeSource('blue', 1_700_000_100)

    expect(await Image.url('/images/logo.png', {width: 10, format: 'webp'})).toBe(first)

    const now = Date.now()
    jest.spyOn(Date, 'now').mockReturnValue(now + Image.MTIME_TTL + 1)
    expect(await Image.url('/images/logo.png', {width: 10, format: 'webp'})).not.toBe(first)
  })
})
