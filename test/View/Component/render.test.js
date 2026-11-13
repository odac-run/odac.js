const {project} = require('../project')

describe('View components', () => {
  const app = project()
  beforeEach(app.setup)
  afterEach(app.teardown)

  // Each call renders its own view file: rewriting one path within a millisecond keeps its mtime.
  let pages
  beforeEach(() => {
    pages = 0
  })
  const page = async (html, options) => {
    const name = `page${++pages}`
    await app.write(`view/content/${name}.html`, html)
    return app.render(name, options)
  }

  describe('props', () => {
    beforeEach(async () => {
      await app.write(
        'view/components/badge.html',
        `<odac:props label="'New'" tone="'info'" />\n<span class="badge-{{ tone }}">{{ label }}</span>`
      )
    })

    it('renders defaults and overrides them with attributes', async () => {
      expect(await page('<c:badge /> <c:badge label="Sale" tone="warn" />')).toBe(
        '<span class="badge-info">New</span> <span class="badge-warn">Sale</span>'
      )
    })

    it('interpolates {{ }} in attribute values and binds :prop expressions', async () => {
      await app.write('view/components/user.html', '<odac:props title :user />\n<b>{{ title }}</b>:{{ user.name }}:{{ typeof user }}')
      const html = await page('<c:user title="No. {{ id + 1 }}" :user="{name: name}" />', {variables: {id: 1, name: 'Ada'}})
      expect(html).toBe('<b>No. 2</b>:Ada:object')
    })

    it('escapes prop values once, where they are printed', async () => {
      expect(await page(`<c:badge label="{{ text }}" />`, {variables: {text: '<i>&</i>'}})).toBe(
        '<span class="badge-info">&lt;i&gt;&amp;&lt;/i&gt;</span>'
      )
    })

    it('maps kebab-case attributes to camelCase props and bare attributes to true', async () => {
      await app.write('view/components/flags.html', '<odac:props maxItems="0" open="false" />\n{{ maxItems }}/{{ open }}')
      expect(await page('<c:flags max-items="5" open />')).toBe('5/true')
    })

    it('exposes every passed value on props', async () => {
      await app.write('view/components/raw.html', `{{ props.dataId }} {{ props.title }}`)
      expect(await page('<c:raw data-id="7" title="t" />')).toBe('7 t')
    })

    it('lets a default await, and use the props declared before it', async () => {
      await app.write(
        'view/components/total.html',
        `<odac:props price="await Promise.resolve(10)" total="price * 2" />\n<b>{{ price }}/{{ total }}</b>`
      )
      expect(await page('<c:total /> <c:total :price="3" />')).toBe('<b>10/20</b> <b>3/6</b>')
    })

    it('reports a failing default at the <odac:props> line', async () => {
      await app.write('view/components/broken.html', `<p>first</p>\n<odac:props label="missing.value" />\n<span>{{ label }}</span>`)
      expect(await page('<c:broken label="ok" />')).toBe('<p>first</p>\n\n<span>ok</span>')
      expect(await page('<c:broken />')).toBeUndefined()
      expect(app.logged()).toContain('ReferenceError: missing is not defined\n  in line 2\n  of "./view/components/broken.html"')
    })

    it('reports a default that does not parse at the <odac:props> line', async () => {
      await app.write('view/components/unparsed.html', `<p>first</p>\n<p>second</p>\n<odac:props label="1 +" />`)
      expect(await page('<c:unparsed />')).toBeUndefined()
      expect(app.logged()).toContain('\n  in line 3\n  of "./view/components/unparsed.html"\n  used in "./view/content/page1.html"')
    })

    it('answers 500 when a required prop is missing, naming the caller', async () => {
      await app.write('view/components/needs.html', '<odac:props :user />\n{{ user.name }}')
      expect(await page('<p>x</p>\n<c:needs />')).toBeUndefined()
      expect(app.odac.Request.abort).toHaveBeenCalledWith(500)
      expect(app.logged()).toContain('Component "needs" requires the "user" prop\n  in line 2\n  of "./view/content/page1.html"')
    })
  })

  describe('attributes', () => {
    it('passes undeclared attributes through {!! attrs !!}, escaped', async () => {
      await app.write('view/components/box.html', '<odac:props size="1" />\n<div {!! attrs !!}>{{ size }}</div>')
      const html = await page(`<c:box size="2" id="main" data-note="{{ note }}" hidden :aria-busy="false" :title="null" />`, {
        variables: {note: '"quoted" <b>'}
      })
      expect(html).toBe('<div id="main" data-note="&quot;quoted&quot; &lt;b&gt;" hidden>2</div>')
    })

    it('merges classes with attrs.class() and filters with only()/except()', async () => {
      await app.write(
        'view/components/btn.html',
        `<button {!! attrs.class('btn').except('id') !!}>{{ attrs.has('id') }}</button><i {!! attrs.only('id') !!}></i>`
      )
      expect(await page('<c:btn class="wide" id="b1" type="submit" />')).toBe(
        '<button class="btn wide" type="submit">true</button><i id="b1"></i>'
      )
      expect(await page('<c:btn />')).toBe('<button class="btn">false</button><i ></i>')
    })
  })

  describe('slots', () => {
    beforeEach(async () => {
      await app.write(
        'view/components/card.html',
        [
          `<odac:props title="'Card'" />`,
          `<section><h3>{{ title }}</h3>`,
          `<odac:slot>Empty</odac:slot>`,
          `<footer><odac:slot name="footer">Default footer</odac:slot></footer>`,
          `<odac:if condition="slots.aside"><aside><odac:slot name="aside" /></aside></odac:if></section>`
        ].join('\n')
      )
    })

    it('renders children as the default slot and falls back without them', async () => {
      expect(await page('<c:card><p>Body</p></c:card>')).toBe(
        '<section><h3>Card</h3>\n<p>Body</p>\n<footer>Default footer</footer>\n</section>'
      )
      expect(await page('<c:card>   </c:card>')).toBe('<section><h3>Card</h3>\nEmpty\n<footer>Default footer</footer>\n</section>')
    })

    it('renders named slots, and skips markup for slots that were not provided', async () => {
      const html = await page(
        '<c:card title="T"><p>Body</p><odac:slot name="footer"><b>F</b></odac:slot><odac:slot name="aside">A</odac:slot></c:card>'
      )
      expect(html).toBe('<section><h3>T</h3>\n<p>Body</p>\n<footer><b>F</b></footer>\n<aside>A</aside></section>')
    })

    it('renders slot content in the caller scope', async () => {
      const html = await page(
        '<odac:for in="items" value="item"><c:card :title="item.name">#{{ item.id }} of {{ owner }}<odac:slot name="footer">{{ item.id * 10 }}</odac:slot></c:card></odac:for>',
        {
          variables: {
            owner: 'Ada',
            items: [
              {id: 1, name: 'One'},
              {id: 2, name: 'Two'}
            ]
          }
        }
      )
      expect(html).toContain('<h3>One</h3>\n#1 of Ada\n<footer>10</footer>')
      expect(html).toContain('<h3>Two</h3>\n#2 of Ada\n<footer>20</footer>')
    })

    it('provides a named slot conditionally', async () => {
      const html = await page('<c:card><odac:if condition="show"><odac:slot name="footer">Shown</odac:slot></odac:if></c:card>', {
        variables: {show: false}
      })
      expect(html).toContain('<footer>Default footer</footer>')
    })

    // A paired default `<odac:slot>` inside a component tag prints the wrapper's own slot; it is
    // not a slot provided to the inner component, which would drop what the wrapper was given.
    it('prints its own default slot, with a fallback, inside another component', async () => {
      await app.write('view/components/box.html', '<c:card title="Box"><div class="box"><odac:slot>Empty box</odac:slot></div></c:card>')
      expect(await page('<c:box>Given</c:box>')).toContain('<div class="box">Given</div>')
      expect(await page('<c:box />')).toContain('<div class="box">Empty box</div>')
      // In a page there is no slot to print: the fallback is the content of the component.
      expect(await page('<c:card><odac:slot>Loose</odac:slot></c:card>')).toContain('</h3>\nLoose\n<footer>')
    })

    it('forwards slots through a wrapping component', async () => {
      await app.write(
        'view/components/panel.html',
        '<div class="panel"><c:card title="Panel"><odac:slot /><odac:slot name="footer"><odac:slot name="footer">Panel footer</odac:slot></odac:slot></c:card></div>'
      )
      expect(await page('<c:panel>Inner</c:panel>')).toBe(
        '<div class="panel"><section><h3>Panel</h3>\nInner\n<footer>Panel footer</footer>\n</section></div>'
      )
      expect(await page('<c:panel>Inner<odac:slot name="footer">Mine</odac:slot></c:panel>')).toContain('<footer>Mine</footer>')
    })
  })

  describe('composition', () => {
    it('resolves dotted names and the long form to subdirectories', async () => {
      await app.write('view/components/ui/icon.html', '<odac:props name />\n<i class="i-{{ name }}"></i>')
      expect(await page('<c:ui.icon name="a" /><odac:component name="ui.icon" name2="x" :name="\'b\'" />')).toBe(
        '<i class="i-a"></i><i class="i-b"></i>'
      )
    })

    it('renders components inside components', async () => {
      await app.write('view/components/item.html', '<odac:props :label />\n<li>{{ label }}</li>')
      await app.write(
        'view/components/menu.html',
        '<odac:props :entries />\n<ul><odac:for in="entries" value="entry"><c:item :label="entry" /></odac:for></ul>'
      )
      expect(await page(`<nav><c:menu :entries="['a', 'b']" /></nav>`)).toBe('<nav><ul><li>a</li><li>b</li></ul></nav>')
    })

    it('renders a component that renders itself', async () => {
      await app.write(
        'view/components/tree.html',
        '<odac:props :node />\n<li>{{ node.name }}<odac:if condition="node.children"><ul><odac:for in="node.children" value="child"><c:tree :node="child" /></odac:for></ul></odac:if></li>'
      )
      const tree = {name: 'root', children: [{name: 'a', children: [{name: 'a1'}]}, {name: 'b'}]}
      expect(await page('<ul><c:tree :node="tree" /></ul>', {variables: {tree}})).toBe(
        '<ul><li>root<ul><li>a<ul><li>a1</li></ul></li><li>b</li></ul></li></ul>'
      )
    })

    it('keeps the caller scope out of the component', async () => {
      await app.write('view/components/leak.html', '{{ secret }}')
      expect(await page('<c:leak />', {variables: {secret: 'x'}})).toBeUndefined()
      expect(app.logged()).toContain('secret is not defined')
    })
  })

  describe('failures', () => {
    it('answers 500 for a missing component', async () => {
      expect(await page('<c:missing />')).toBeUndefined()
      expect(app.logged()).toContain(
        'Component "missing" not found (./view/components/missing.html)\n  in line 1\n  of "./view/content/page1.html"'
      )
    })

    it('reports an error inside a component with its line and the caller chain', async () => {
      await app.write('view/components/inner.html', '<odac:props :value />\n<p>{{ value.deep.deeper }}</p>')
      await app.write('view/components/outer.html', '<div>\n<c:inner :value="{}" />\n</div>')
      expect(await page('<c:outer />')).toBeUndefined()
      const logged = app.logged()
      expect(logged).toContain('Cannot read properties of undefined (reading \'deeper\')\n  in line 2\n  of "./view/components/inner.html"')
      expect(logged).toContain('used in "./view/components/outer.html"\n  used in "./view/content/page1.html"')
      expect(app.errors).toHaveBeenCalledTimes(1)
    })

    it('reports an error inside slot content in the caller template', async () => {
      await app.write('view/components/wrap.html', '<div><odac:slot name="body" /></div>')
      expect(await page('<c:wrap>\n<odac:slot name="body">\n{{ nope }}\n</odac:slot>\n</c:wrap>')).toBeUndefined()
      expect(app.logged()).toContain('nope is not defined\n  in line 3\n  of "./view/content/page1.html"')
    })

    it('stops a component that renders itself forever', async () => {
      await app.write('view/components/loop.html', '<c:loop />')
      expect(await page('<c:loop />')).toBeUndefined()
      expect(app.logged()).toContain('Components are nested more than 50 levels deep at "loop"')
      expect(app.logged()).toContain('used in "./view/components/loop.html" (49 times)\n  used in "./view/content/page1.html"')
    })

    it('answers 500 for malformed component markup, with its line', async () => {
      expect(await page('<c:card>\n<p>\n</c:list>')).toBeUndefined()
      expect(app.logged()).toContain('</c:list> does not match <c:card> opened in line 1\n  in line 3\n  of "./view/content/page1.html"')
    })
  })

  describe('caching', () => {
    it('picks up a changed component in debug and keeps the compiled one in production', async () => {
      await app.write('view/components/note.html', 'v1')
      expect(await page('<c:note />')).toBe('v1')

      await new Promise(resolve => setTimeout(resolve, 20))
      await app.write('view/components/note.html', 'v2')
      expect(await app.render('page1')).toBe('v2')

      await new Promise(resolve => setTimeout(resolve, 20))
      await app.write('view/components/note.html', 'v3')
      expect(await app.render('page1', {debug: false})).toBe('v2')
    })

    it('reads a component once per request in debug, however often it is used', async () => {
      await app.write('view/components/dot.html', '.')
      const fsPromises = require('fs').promises
      const open = jest.spyOn(fsPromises, 'open')
      expect(await page('<odac:for in="[1, 2, 3, 4]" value="i"><c:dot /></odac:for>')).toBe('....')
      expect(open.mock.calls.filter(([file]) => String(file).endsWith('dot.html'))).toHaveLength(1)
    })
  })

  describe('Odac.View.component()', () => {
    beforeEach(async () => {
      await app.write(
        'view/components/ui/button.html',
        `<odac:props variant="'primary'" />\n<button {!! attrs.class('btn-' + variant) !!}><odac:slot>Go</odac:slot></button>`
      )
    })

    it('renders a component with props and escaped attributes', async () => {
      const view = app.view()
      const html = await view.component('ui.button', {variant: 'ghost', title: '<x>', 'bad"name': 1, onclick: false})
      expect(html).toBe('<button class="btn-ghost" title="&lt;x&gt;">Go</button>')
    })

    it('rejects a missing component or an unsafe name', async () => {
      const view = app.view()
      await expect(view.component('nope')).rejects.toThrow('Component "nope" not found')
      await expect(view.component('../content/page')).rejects.toThrow('Invalid component name "../content/page"')
      expect(app.logged()).toContain('of "Odac.View.component()"')
    })
  })
})
