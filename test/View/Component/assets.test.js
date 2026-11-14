const {project} = require('../project')

// `once` blocks render once per response; `<odac:push>` content reaches `<odac:stack>` markers in
// the skeleton or any part, and AJAX navigation sends it to the browser as `stacks`.
describe('View component assets: once, push and stack', () => {
  const app = project()
  beforeEach(app.setup)
  afterEach(app.teardown)

  const skeleton = () =>
    app.write(
      'skeleton/main.html',
      '<html><head><title>T</title><odac:stack name="head" /></head><body><main>{{ CONTENT }}</main><odac:stack name="scripts" /></body></html>'
    )

  beforeEach(async () => {
    await app.write(
      'view/components/chart.html',
      [
        '<odac:props :points />',
        '<odac:push to="head"><link rel="stylesheet" href="/css/chart.css"></odac:push>',
        '<odac:push to="scripts"><script src="/js/chart.js"></script></odac:push>',
        '<style once>.chart{color:red}</style>',
        '<script once type="module">window.charts = 1</script>',
        '<odac:once><div id="tooltip"></div></odac:once>',
        `<div class="chart">{{ points.join(',') }}</div>`
      ].join('\n')
    )
  })

  describe('once', () => {
    it('renders once blocks a single time however often the component is used', async () => {
      await app.write(
        'view/content/charts.html',
        `<c:chart :points="[1]" /><odac:for in="[2, 3]" value="p"><c:chart :points="[p]" /></odac:for>`
      )
      const html = await app.render('charts')
      expect(html.match(/<style>/g)).toHaveLength(1)
      expect(html.match(/<script type="module">window\.charts = 1<\/script>/g)).toHaveLength(1)
      expect(html.match(/id="tooltip"/g)).toHaveLength(1)
      expect(html.match(/class="chart"/g)).toHaveLength(3)
      expect(html).not.toContain('once')
    })

    it('renders once blocks again in the next response', async () => {
      await app.write('view/content/one.html', '<c:chart :points="[1]" />')
      expect(await app.render('one')).toContain('<style>.chart{color:red}</style>')
      expect(await app.render('one')).toContain('<style>.chart{color:red}</style>')
    })

    it('keeps the blocks of different templates apart', async () => {
      await app.write('view/components/a.html', '<odac:once>A</odac:once>')
      await app.write('view/components/b.html', '<odac:once>B</odac:once>')
      await app.write('view/content/ab.html', '<c:a /><c:b /><c:a /><c:b />')
      expect(await app.render('ab')).toBe('AB')
    })

    it('leaves plain <script> and <style> content alone, including component-like text', async () => {
      await app.write('view/content/plain.html', `<script>const tag = '<c:card />'</script><style>a:hover{}</style>`)
      expect(await app.render('plain')).toBe(`<script>const tag = '<c:card />'</script><style>a:hover{}</style>`)
    })
  })

  describe('push and stack', () => {
    it('prints pushed content at the stack markers of the page, each item once', async () => {
      await skeleton()
      await app.write('view/content/page.html', '<c:chart :points="[1]" /><c:chart :points="[2]" />')
      const html = await app.renderPage('page')
      expect(html).toMatch(
        /<head><title>T<\/title><link rel="stylesheet" href="\/css\/chart\.css"><template data-odac-stack="head" data-odac-keys="[0-9a-f]{16}"><\/template><\/head>/
      )
      expect(html).toMatch(
        /<\/main><script src="\/js\/chart\.js"><\/script><template data-odac-stack="scripts" data-odac-keys="[0-9a-f]{16}"><\/template>/
      )
      expect(html.match(/chart\.css/g)).toHaveLength(1)
      expect(html).not.toContain('<odac:stack')
    })

    it('renders pushed content in the scope where it is pushed', async () => {
      await skeleton()
      await app.write('view/content/meta.html', '<odac:push to="head"><meta name="page" content="{{ page }}"></odac:push><p>x</p>')
      const html = await app.renderPage('meta', {variables: {page: 'a&b'}})
      expect(html).toContain('<meta name="page" content="a&amp;b"><template data-odac-stack="head"')
      expect(html).toContain('<main data-odac-navigate="content"><p>x</p></main>')
    })

    it('leaves empty markers for stacks nothing was pushed to, and removes repeated markers', async () => {
      await app.write('skeleton/main.html', '<head><odac:stack name="head" /><odac:stack name="head" /></head><main>{{ CONTENT }}</main>')
      await app.write('view/content/empty.html', '<p>x</p>')
      expect(await app.renderPage('empty')).toContain('<head><template data-odac-stack="head" data-odac-keys=""></template></head>')
    })

    it('sends the pushes of an AJAX navigation as stacks and keeps markers in parts empty', async () => {
      await app.write(
        'view/content/nav.html',
        '<c:chart :points="[1]" /><odac:stack name="inline" /><odac:push to="inline"><i>i</i></odac:push>'
      )
      const payload = await app.renderAjax('nav')
      expect(payload.stacks.head).toEqual([
        {key: expect.stringMatching(/^[0-9a-f]{16}$/), html: '<link rel="stylesheet" href="/css/chart.css">'}
      ])
      expect(payload.stacks.scripts[0].html).toBe('<script src="/js/chart.js"></script>')
      expect(payload.stacks.inline[0].html).toBe('<i>i</i>')
      expect(payload.output.content).toContain('<template data-odac-stack="inline" data-odac-keys=""></template>')
      expect(payload.output.content).not.toContain('<i>i</i>')
    })

    it('uses the same key for the same content on the page and in a navigation', async () => {
      await skeleton()
      await app.write('view/content/same.html', '<c:chart :points="[1]" />')
      const key = (await app.renderPage('same')).match(/data-odac-stack="head" data-odac-keys="([0-9a-f]{16})"/)[1]
      expect((await app.renderAjax('same')).stacks.head[0].key).toBe(key)
    })

    it('omits stacks from a navigation that pushed nothing', async () => {
      await app.write('view/content/none.html', '<p>x</p>')
      expect((await app.renderAjax('none')).stacks).toBeUndefined()
    })
  })

  describe('dynamic components', () => {
    beforeEach(async () => {
      await app.write('view/components/widgets/text.html', '<odac:props :value />\n<p>{{ value }}</p>')
      await app.write('view/components/widgets/number.html', '<odac:props :value />\n<b>{{ value * 2 }}</b>')
    })

    it('renders the component named by :is', async () => {
      await app.write(
        'view/content/dash.html',
        `<odac:for in="widgets" value="w"><odac:component :is="'widgets.' + w.type" :value="w.value" /></odac:for>`
      )
      const widgets = [
        {type: 'text', value: 'hi'},
        {type: 'number', value: 4}
      ]
      expect(await app.render('dash', {variables: {widgets}})).toBe('<p>hi</p><b>8</b>')
    })

    it('rejects an :is name that leaves the component directory', async () => {
      await app.write('view/content/escape.html', '<p>x</p>\n<odac:component :is="name" />')
      expect(await app.render('escape', {variables: {name: '../content/escape'}})).toBeUndefined()
      expect(app.logged()).toContain('Invalid component name "../content/escape"\n  in line 2\n  of "./view/content/escape.html"')
    })
  })
})
