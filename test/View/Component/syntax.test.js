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
    ['<odac:component title="x" />', '<odac:component> needs a name="..."', 1],
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
    expect(compileTemplate('<c:card />', {components: true}).code).toContain('__c("card", 1, [], null)')
  })
})
