const fs = require('fs')
const os = require('os')
const path = require('path')
const Validator = require('../../src/Validator')

// Minimal Odac stub — file rules never touch Var()/Auth(), but other rules do,
// so provide a small shim to keep the constructor happy.
const odacStub = {
  Var: () => ({is: () => false})
}

function mockRequest(filesByField) {
  return {
    file: async name => {
      const arr = filesByField[name]
      if (!arr) return null
      return arr.length === 1 ? arr[0] : arr
    }
  }
}

function fileObj(overrides = {}) {
  return {
    field: 'upload',
    name: 'file.bin',
    ext: 'bin',
    mimetype: 'application/octet-stream',
    size: 1000,
    path: null,
    truncated: false,
    stored: false,
    ...overrides
  }
}

describe('Validator file rules', () => {
  let tmpDir

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'odac-file-test-'))
  })

  afterAll(() => {
    fs.rmSync(tmpDir, {recursive: true, force: true})
  })

  function writeTmp(name, buf) {
    const p = path.join(tmpDir, name)
    fs.writeFileSync(p, buf)
    return p
  }

  describe('required', () => {
    it('fails when no file is present', async () => {
      const v = new Validator(mockRequest({}), odacStub)
      v.file('avatar').check('required').message('Avatar required')
      expect(await v.error()).toBe(true)
    })

    it('passes when a file is present', async () => {
      const v = new Validator(mockRequest({avatar: [fileObj()]}), odacStub)
      v.file('avatar').check('required').message('Avatar required')
      expect(await v.error()).toBe(false)
    })
  })

  describe('maxsize / minsize', () => {
    it('rejects a file above maxsize', async () => {
      const v = new Validator(mockRequest({doc: [fileObj({size: 3 * 1024 * 1024})]}), odacStub)
      v.file('doc').check('maxsize:2MB').message('Too large')
      expect(await v.error()).toBe(true)
    })

    it('accepts a file at/below maxsize', async () => {
      const v = new Validator(mockRequest({doc: [fileObj({size: 1024 * 1024})]}), odacStub)
      v.file('doc').check('maxsize:2MB').message('Too large')
      expect(await v.error()).toBe(false)
    })

    it('rejects a file below minsize', async () => {
      const v = new Validator(mockRequest({doc: [fileObj({size: 500})]}), odacStub)
      v.file('doc').check('minsize:1KB').message('Too small')
      expect(await v.error()).toBe(true)
    })
  })

  describe('ext', () => {
    it('rejects a disallowed extension', async () => {
      const v = new Validator(mockRequest({img: [fileObj({ext: 'gif'})]}), odacStub)
      v.file('img').check('ext:jpg,png').message('Bad ext')
      expect(await v.error()).toBe(true)
    })

    it('accepts an allowed extension', async () => {
      const v = new Validator(mockRequest({img: [fileObj({ext: 'png'})]}), odacStub)
      v.file('img').check('ext:jpg,png').message('Bad ext')
      expect(await v.error()).toBe(false)
    })
  })

  describe('maxfiles', () => {
    it('rejects too many files', async () => {
      const files = [fileObj(), fileObj(), fileObj()]
      const v = new Validator(mockRequest({docs: files}), odacStub)
      v.file('docs').check('maxfiles:2').message('Too many')
      expect(await v.error()).toBe(true)
    })

    it('accepts within the limit', async () => {
      const files = [fileObj(), fileObj()]
      const v = new Validator(mockRequest({docs: files}), odacStub)
      v.file('docs').check('maxfiles:2').message('Too many')
      expect(await v.error()).toBe(false)
    })
  })

  describe('mimetype', () => {
    const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])

    it('accepts a genuine PNG matching the whitelist', async () => {
      const p = writeTmp('real.png', PNG)
      const file = fileObj({ext: 'png', mimetype: 'image/png', path: p})
      const v = new Validator(mockRequest({avatar: [file]}), odacStub)
      v.file('avatar').check('mimetype:image/png,image/jpeg').message('Bad type')
      expect(await v.error()).toBe(false)
    })

    it('rejects a spoofed .png whose bytes are not PNG', async () => {
      const p = writeTmp('fake.png', Buffer.from('<script>alert(1)</script>'))
      const file = fileObj({ext: 'png', mimetype: 'image/png', path: p})
      const v = new Validator(mockRequest({avatar: [file]}), odacStub)
      v.file('avatar').check('mimetype:image/png,image/jpeg').message('Bad type')
      expect(await v.error()).toBe(true)
    })

    it('rejects a type outside the whitelist', async () => {
      const file = fileObj({ext: 'pdf', mimetype: 'application/pdf'})
      const v = new Validator(mockRequest({avatar: [file]}), odacStub)
      v.file('avatar').check('mimetype:image/png,image/jpeg').message('Bad type')
      expect(await v.error()).toBe(true)
    })

    it('supports image/* wildcard', async () => {
      const p = writeTmp('w.png', PNG)
      const file = fileObj({ext: 'png', mimetype: 'image/png', path: p})
      const v = new Validator(mockRequest({avatar: [file]}), odacStub)
      v.file('avatar').check('accept:image/*').message('Bad type')
      expect(await v.error()).toBe(false)
    })

    const check = async (file, rule) => {
      const v = new Validator(mockRequest({upload: [file]}), odacStub)
      v.file('upload').check(rule).message('Bad type')
      return v.error()
    }

    it('ignores the client-declared type: evil.html sent as image/png fails image/*', async () => {
      const p = writeTmp('evil.html', Buffer.from('<script>alert(1)</script>'))
      expect(await check(fileObj({name: 'evil.html', ext: 'html', mimetype: 'image/png', path: p}), 'mimetype:image/*')).toBe(true)
      expect(await check(fileObj({name: 'evil.html', ext: 'html', mimetype: 'image/png', path: p}), 'mimetype:image/png')).toBe(true)
    })

    it('keeps SVG out of image/* but allows it when listed explicitly', async () => {
      const p = writeTmp('logo.svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))
      const file = () => fileObj({name: 'logo.svg', ext: 'svg', mimetype: 'image/svg+xml', path: p})
      expect(await check(file(), 'mimetype:image/*')).toBe(true)
      expect(await check(file(), 'mimetype:image/svg+xml')).toBe(false)
    })

    it('keeps HTML out of text/*', async () => {
      const p = writeTmp('page.html', Buffer.from('<p>x</p>'))
      expect(await check(fileObj({ext: 'html', mimetype: 'text/plain', path: p}), 'mimetype:text/*')).toBe(true)
      const txt = writeTmp('notes.txt', Buffer.from('plain'))
      expect(await check(fileObj({ext: 'txt', mimetype: 'text/plain', path: txt}), 'mimetype:text/*')).toBe(false)
    })

    it('checks PDF and Office signatures', async () => {
      const pdf = writeTmp('real.pdf', Buffer.from('%PDF-1.7\n'))
      const fakePdf = writeTmp('fake.pdf', Buffer.from('<html></html>'))
      const docx = writeTmp('real.docx', Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]))
      expect(await check(fileObj({ext: 'pdf', path: pdf}), 'mimetype:application/pdf')).toBe(false)
      expect(await check(fileObj({ext: 'pdf', path: fakePdf}), 'mimetype:application/pdf')).toBe(true)
      expect(
        await check(fileObj({ext: 'docx', path: docx}), 'mimetype:application/vnd.openxmlformats-officedocument.wordprocessingml.document')
      ).toBe(false)
    })

    it('accepts extensions known to the framework MIME table', async () => {
      const p = writeTmp('photo.avif', Buffer.from('....ftypavif'))
      expect(await check(fileObj({ext: 'avif', mimetype: 'application/octet-stream', path: p}), 'mimetype:image/avif')).toBe(false)
    })
  })

  describe('truncated files', () => {
    it('always fails, even with only a size rule that it would pass', async () => {
      const file = fileObj({truncated: true, path: null, size: 0})
      const v = new Validator(mockRequest({big: [file]}), odacStub)
      v.file('big').check('maxsize:2MB').message('File too large')
      expect(await v.error()).toBe(true)
    })
  })

  describe('parameterized-rule split regression', () => {
    it('parses maxsize suffix correctly via split(/:(.+)/)', async () => {
      const under = new Validator(mockRequest({d: [fileObj({size: 1024})]}), odacStub)
      under.file('d').check('maxsize:2KB').message('x')
      expect(await under.error()).toBe(false)

      const over = new Validator(mockRequest({d: [fileObj({size: 4096})]}), odacStub)
      over.file('d').check('maxsize:2KB').message('x')
      expect(await over.error()).toBe(true)
    })
  })
})
