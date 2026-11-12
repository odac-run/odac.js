const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const Extractor = require('../../src/Lang/Extractor')

describe('Lang Extractor', () => {
  describe('readLiteral()', () => {
    const read = source => Extractor.readLiteral(source, 0)?.value ?? null

    it('reads single, double and template literals', () => {
      expect(read("'a'")).toBe('a')
      expect(read('"a"')).toBe('a')
      expect(read('`a`')).toBe('a')
    })

    it('decodes escapes the way JavaScript does', () => {
      expect(read("'It\\'s'")).toBe("It's")
      expect(read("'a\\\\b'")).toBe('a\\b')
      expect(read("'\\n\\t\\x41\\u0042\\u{1F600}\\0'")).toBe('\n\tAB😀\0')
      expect(read("'line \\\ncontinued'")).toBe('line continued')
      expect(read('`a\r\nb`')).toBe('a\nb')
    })

    it('rejects what is not a plain literal', () => {
      expect(read('key')).toBeNull()
      expect(read('`status.${code}`')).toBeNull()
      expect(read("'unterminated")).toBeNull()
      expect(read("'line\nbreak'")).toBeNull()
      expect(read("'\\xZZ'")).toBeNull()
      expect(read("'\\1'")).toBeNull()
    })
  })

  describe('scanSource()', () => {
    it('finds __, __x, Lang.get and Lang.getx calls with their lines', () => {
      const source = [
        "Odac.__('One')",
        "await __x('Gül', 'verb', 1)",
        "this.#odac.Lang.get( 'Two' )",
        "Odac.Lang.getx('Open',\n  'status')"
      ].join('\n')
      expect(Extractor.scanSource(source)).toEqual({
        entries: [
          {key: 'One', context: '', line: 1},
          {key: 'Gül', context: 'verb', line: 2},
          {key: 'Two', context: '', line: 3},
          {key: 'Open', context: 'status', line: 4}
        ],
        dynamic: []
      })
    })

    it('reports calls whose key or context is not a literal as dynamic', () => {
      const {entries, dynamic} = Extractor.scanSource("__(name)\n__x('Gül', ctx)\n__x('Gül')\n__(`a${b}`)")
      expect(entries).toEqual([])
      expect(dynamic.map(d => d.line)).toEqual([1, 2, 3, 4])
    })

    it('does not match other functions', () => {
      const {entries, dynamic} = Extractor.scanSource("foo__('a'); my__x('b'); myLang.get('c'); map.get('d'); $__('e')")
      expect(entries).toEqual([])
      expect(dynamic).toEqual([])
    })
  })

  describe('keepMatcher()', () => {
    it('matches exact keys and * prefixes', () => {
      const keep = Extractor.keepMatcher({lang: {keep: ['status.*', 'Exact', '', 5]}})
      expect(keep('status.ok')).toBe(true)
      expect(keep('Exact')).toBe(true)
      expect(keep('Exact2')).toBe(false)
      expect(keep('other')).toBe(false)
      expect(Extractor.keepMatcher({})('x')).toBe(false)
    })
  })

  describe('extract()', () => {
    let root

    const write = (file, content) => {
      fs.mkdirSync(path.dirname(path.join(root, file)), {recursive: true})
      fs.writeFileSync(path.join(root, file), content)
    }

    beforeEach(() => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), 'odac-extract-'))
    })

    afterEach(() => {
      fs.rmSync(root, {recursive: true, force: true})
    })

    it('derives view keys exactly as the compiler does', async () => {
      write(
        'view/content/home.html',
        [
          '<odac translate>Welcome back, <odac var="user.name" />!</odac>',
          '<odac translate context="verb">Gül</odac>',
          "<odac translate>It's <odac>fine</odac></odac>",
          "{{ __('Inline') }}",
          "<script:odac>await Odac.__('Script block')</script:odac>"
        ].join('\n')
      )
      write('skeleton/main.html', '<title><odac translate>Site</odac></title>{{ CONTENT }}')
      const {entries} = await Extractor.extract(root)
      expect([...entries.values()].map(e => [e.key, e.context])).toEqual([
        ['Site', ''],
        ['Welcome back, %s1!', ''],
        ['Gül', 'verb'],
        ["It's %s1", ''],
        ['Inline', ''],
        ['Script block', '']
      ])
      expect([...entries.values()][1].files).toEqual(new Set(['view/content/home.html']))
    })

    it('marks entries used under view/js as frontend entries', async () => {
      write('view/js/app.js', "Odac.__('Shared'); Odac.__x('Open', 'button')")
      write('view/js/lib/_util.ts', "export const t = () => Odac.__('Nested')")
      write('controller/home.js', "Odac.__('Shared'); Odac.__('Backend')")
      const {entries} = await Extractor.extract(root)
      const frontend = [...entries.values()].filter(e => e.frontend).map(e => e.key)
      expect(frontend.sort()).toEqual(['Nested', 'Open', 'Shared'])
      expect(entries.get('Shared\u0000').files).toEqual(new Set(['controller/home.js:1', 'view/js/app.js:1']))
    })

    it('skips dependencies, runtime data, static files, dot directories and minified files', async () => {
      write('node_modules/pkg/index.js', "__('dep')")
      write('class/node_modules/pkg/index.js', "__('nested dep')")
      write('storage/x.js', "__('storage')")
      write('public/assets/js/app.js', "__('public')")
      write('.git/hook.js', "__('git')")
      write('view/js/vendor.min.js', "__('minified')")
      write('README.md', "__('docs')")
      write('route/www.js', "__('route')")
      const {entries} = await Extractor.extract(root)
      expect([...entries.values()].map(e => e.key)).toEqual(['route'])
    })

    it('reports dynamic calls with their file and files that fail to compile', async () => {
      write('controller/a.js', 'Odac.__(key)')
      const {dynamic} = await Extractor.extract(root)
      expect(dynamic).toEqual([{file: 'controller/a.js', line: 1, call: '__(key)'}])
    })

    it('limits the scan to a directory when asked', async () => {
      write('view/js/app.js', "__('front')")
      write('controller/a.js', "__('back')")
      const {entries} = await Extractor.extract(root, {dir: 'view/js'})
      expect([...entries.values()].map(e => e.key)).toEqual(['front'])
    })
  })

  it('lists every key the framework translates in FRAMEWORK_KEYS', async () => {
    const src = path.resolve(__dirname, '../../src')
    const {entries} = await Extractor.extract(src)
    // The extractor documents its own call patterns.
    const keys = [...entries.values()].filter(e => [...e.files].some(file => !file.startsWith('Lang/Extractor.js'))).map(e => e.key)
    expect(keys.sort()).toEqual([...Extractor.FRAMEWORK_KEYS].sort())
  })
})
