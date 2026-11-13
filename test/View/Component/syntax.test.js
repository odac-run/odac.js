const {transform, TemplateError} = require('../../../src/View/ComponentSyntax')
const {compile, compileTemplate} = require('../../../src/View/Compiler')

const lines = text => text.split('\n').length

const failsWith = (source, message, line, options) => {
  let error
  try {
    transform(source, options)
  } catch (e) {
    error = e
  }
  expect(error).toBeInstanceOf(TemplateError)
  expect(error.message).toBe(message)
  expect(error.line).toBe(line)
}

describe('Component syntax', () => {
  it('keeps the line count of every tag it rewrites', () => {
    const source = '<p>a</p>\n<c:card\n  title="x"\n  :user="u">\n<odac:slot\n name="footer">f</odac:slot>\n</c:card>\n<p>b</p>'
    expect(lines(transform(source).content)).toBe(lines(source))
  })

  it('leaves component tags inside backend code and backend comments alone', () => {
    const source = [
      '<script:odac>const tag = "<c:card>"</script:odac>',
      '<odac:js>const other = "</c:card>"</odac:js>',
      '<!--odac <c:hidden /> odac-->',
      '{{-- <c:hidden /> --}}'
    ].join('\n')
    expect(transform(source).content).toBe(source)
  })

  it('reads ">" inside quoted attribute values as part of the value', () => {
    const {content} = transform('<c:gauge :full="count > 5" label="a > b" />')
    expect(content).toContain('["full", await (count > 5)]')
    expect(content).toContain('["label", "a > b"]')
  })

  it('cannot end its own code block from an attribute value', () => {
    const {content} = transform('<c:x label="</odac:js><script>alert(1)</script>" note="`${x}` {{ y }}" />')
    expect(content.match(/<\/odac:js>/g)).toHaveLength(1)
    expect(content).toContain('"\\u003c/odac:js>\\u003cscript>alert(1)\\u003c/script>"')
    expect(content).toContain("`\\`\\${x}\\` ${(await (y)) ?? ''}`")
  })

  it('leaves tags that only start like component tags untouched', () => {
    const source = '<code>c:card</code><odac:components></odac:components><cx:card />'
    expect(transform(source).content).toBe(source)
  })

  it('compiles :is into a component name chosen at render time', () => {
    const {content} = transform('<odac:component :is="w.type" :w="w" />')
    expect(content).toContain('__r.component(await (w.type), 1, [["w", await (w)]], null)')
  })

  it('wraps once blocks in a check identified by file and position', () => {
    const {content} = transform('<odac:once>a</odac:once><style once>b{}</style><script\n  once defer>c()</script>', {file: 'f.html'})
    expect(content).toContain('if (__r.once("f.html#0")) {</odac:js>a<odac:js>}')
    expect(content).toContain('<odac:js>if (__r.once("f.html#1")) {</odac:js><style>b{}</style><odac:js>}</odac:js>')
    expect(content).toContain('<odac:js>if (__r.once("f.html#2")) {</odac:js><script\n defer>c()</script><odac:js>}</odac:js>')
  })

  it('skips the content of plain <script> and <style> elements', () => {
    const source = '<script>const t = "<c:card>"</script><style>/* </c:card> */</style><c:ok />'
    const {content} = transform(source)
    expect(content.startsWith('<script>const t = "<c:card>"</script><style>/* </c:card> */</style>')).toBe(true)
    expect(content).toContain('__r.component("ok"')
  })

  it('compiles a push into a closure rendered in place', () => {
    expect(transform('<odac:push to="head"><link></odac:push>').content).toBe(
      `<odac:js>await __r.push("head", async () => { let html = '';</odac:js><link><odac:js>return html; });</odac:js>`
    )
  })

  it('declares props with defaults and required props', () => {
    const {props, content} = transform('<odac:props title="\'Untitled\'" :user count="1 + 1" />\n<p></p>', {component: true})
    expect(props).toEqual([
      {name: 'title', value: "'Untitled'"},
      {name: 'user', value: undefined},
      {name: 'count', value: '1 + 1'}
    ])
    expect(content).toBe('\n<p></p>')
  })

  it.each([
    ['<c:card>', '<c:card> is never closed', 1],
    ['<p>\n</c:card>', '</c:card> has no opening tag', 2],
    ['<c:card>\n<c:list>\n</c:card>', '</c:card> does not match <c:list> opened in line 2', 3],
    ['<c:card>\n</odac:slot>', '</odac:slot> does not match <c:card> opened in line 1', 2],
    ['<c:card></c:card foo>', 'Malformed closing tag </c:card>', 1],
    ['<c:card title="x"', '<c:card is never closed with ">"', 1],
    ['<c:.bad />', 'Invalid component name ".bad"', 1],
    ['<odac:component title="x" />', '<odac:component> needs a name="..." or :is="..."', 1],
    ['<odac:component name="a" :is="b" />', '<odac:component> takes name="..." or :is="...", not both', 1],
    ['<odac:component :is />', '":is" needs an expression', 1],
    ['<odac:once />', '<odac:once> needs content and a closing </odac:once>', 1],
    ['<odac:push to="head" />', '<odac:push> needs content and a closing </odac:push>', 1],
    ['<odac:push>x</odac:push>', '<odac:push> needs a to="..." stack name', 1],
    ['<odac:push to="a b">x</odac:push>', 'Invalid stack name "a b"', 1],
    ['<odac:push to="head">\n</odac:once>', '</odac:once> does not match <odac:push> opened in line 1', 2],
    ['<p>\n<style once>a{}', '<style once> is never closed', 2],
    ['<odac:component name="{{ n }}" />', '<odac:component> needs a static name="..."', 1],
    ['<odac:slot name="a b" />', 'Invalid slot name "a b"', 1],
    ['<c:x :="y" />', 'An attribute name is missing after ":"', 1],
    ['<c:x :user />', '":user" needs an expression', 1],
    ['<odac:props a />', '<odac:props> is only allowed in components (view/components/)', 1]
  ])('rejects %j', (source, message, line) => {
    failsWith(source, message, line)
  })

  it.each([
    ['<odac:props a></odac:props>', '<odac:props> must be self-closing: <odac:props ... />'],
    ['<odac:props a />\n<odac:props b />', '<odac:props> must appear once, outside other tags'],
    ['<odac:props class />', 'Invalid prop name "class"'],
    ['<odac:props slots />', 'Invalid prop name "slots"'],
    ['<odac:props a b a />', 'Prop "a" is declared twice'],
    ['<odac:props a="" />', 'Prop "a" has an empty default']
  ])('rejects the component declaration %j', (source, message) => {
    expect(() => transform(source, {component: true})).toThrow(message)
  })

  it('compiles component markup only when asked, so mail templates keep it as text', () => {
    expect(compile('<c:card />')).toContain('<c:card />')
    expect(compileTemplate('<c:card />', {components: true}).code).toContain('__r.component("card", 1, [], null)')
  })
})
