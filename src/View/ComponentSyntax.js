const {isLocalName} = require('./Identifiers')

/**
 * Compile-time transform of component markup into template code.
 *
 * Why: component tags nest (a component inside a slot inside a component), and the regex passes
 * of the compiler pair an opening tag with the first closing tag of the same name. This pass
 * walks the tags with a stack instead, so every `</c:card>` closes its own `<c:card>`, and emits
 * each tag as an `<odac:js>` block the compiler then treats like hand-written backend code.
 *
 * - `<c:name attr="..." :prop="expr">children</c:name>` / `<odac:component name="...">` call the
 *   `__c` runtime (see Component.js). Children compile into a closure in the caller's scope, so
 *   loop variables and locals of the page stay available inside slot content.
 * - `<odac:slot name="x">` directly inside a component tag provides a named slot; anywhere else
 *   it outputs the current component's slot, with its children as fallback content.
 * - `<odac:props a="default" b />` declares a component's props (b is required).
 *
 * Generated code is kept on one line and followed by the newlines the tag spanned, so compiled
 * lines stay aligned with the template for error reporting.
 */

class TemplateError extends Error {
  constructor(message, line) {
    super(message)
    this.name = 'TemplateError'
    this.line = line
  }
}

const COMPONENT_NAME = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/
const SLOT_NAME = /^[A-Za-z_][\w-]*$/
// Group 1: a region whose content is not markup (backend JS and backend comments) and is skipped.
// Group 2: `/` of a closing tag. Group 3: `c:` component name. Group 4: `odac:` tag name.
const TOKEN =
  /(<script:odac[^>]*>[\s\S]*?<\/script:odac>|<odac:js>[\s\S]*?<\/odac:js>|<!--odac[\s\S]*?(?:odac-->|-->)|\{\{--[\s\S]*?--\}\})|<(\/?)(?:c:([\w.-]+)|odac:(component|slot|props))(?=[\s/>])/g
const ATTRIBUTE = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g
const INTERPOLATION = /\{\{([\s\S]*?)\}\}|\{!!([\s\S]*?)!!\}/g

// A JavaScript string literal that cannot end the surrounding <odac:js> block.
const literal = text => JSON.stringify(text).replace(/</g, '\\u003c')

// Template literal text with the same guarantees, kept on one line.
const templateText = text =>
  text
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\$\{/g, '\\${')
    .replace(/</g, '\\u003c')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')

// An expression from the template, kept on one line (it always sits inside parentheses).
const expression = code => code.replace(/\r?\n/g, ' ').trim()

const countLines = (text, from, to) => {
  let lines = 0
  for (let i = text.indexOf('\n', from); i !== -1 && i < to; i = text.indexOf('\n', i + 1)) lines++
  return lines
}

// Index of the `>` that ends a tag whose attributes start at `from`; quoted values may hold `>`.
function tagEnd(source, from) {
  let quote = null
  for (let i = from; i < source.length; i++) {
    const char = source[i]
    if (quote) {
      if (char === quote) quote = null
    } else if (char === '"' || char === "'") {
      quote = char
    } else if (char === '>') {
      return i
    }
  }
  return -1
}

function parseAttributes(text) {
  const attributes = []
  for (const match of text.matchAll(ATTRIBUTE)) {
    const value = match[2] ?? match[3] ?? match[4]
    attributes.push({name: match[1], value: value === undefined ? true : value})
  }
  return attributes
}

// A static attribute value, with `{{ expr }}` / `{!! expr !!}` interpolated as plain text.
// Escaping happens where the value is printed, so it is never escaped twice.
function interpolate(value) {
  let code = ''
  let last = 0
  let dynamic = false
  for (const match of value.matchAll(INTERPOLATION)) {
    dynamic = true
    code += templateText(value.slice(last, match.index)) + `\${(await (${expression(match[1] ?? match[2])})) ?? ''}`
    last = match.index + match[0].length
  }
  if (!dynamic) return literal(value)
  return '`' + code + templateText(value.slice(last)) + '`'
}

function attributeList(attributes, line) {
  const pairs = attributes.map(({name, value}) => {
    if (!name.startsWith(':')) return `[${literal(name)}, ${value === true ? 'true' : interpolate(value)}]`
    const key = name.slice(1)
    if (!key) throw new TemplateError('An attribute name is missing after ":"', line)
    if (value === true || !value.trim()) throw new TemplateError(`"${name}" needs an expression`, line)
    return `[${literal(key)}, await (${expression(value)})]`
  })
  return `[${pairs.join(', ')}]`
}

function staticName(attributes, tag, line) {
  const index = attributes.findIndex(attribute => attribute.name === 'name')
  if (index === -1) return {name: null, rest: attributes}
  const {value} = attributes[index]
  if (value === true || /\{\{|\{!!/.test(value)) throw new TemplateError(`<${tag}> needs a static name="..."`, line)
  return {name: value, rest: attributes.filter((_, i) => i !== index)}
}

/**
 * Rewrites component markup into `<odac:js>` blocks.
 * @param {string} source Template markup (after Form and Image transforms).
 * @param {object} [options]
 * @param {boolean} [options.component] The template is a component: `<odac:props>` is allowed.
 * @returns {{content: string, props: Array<{name: string, value: (string|undefined)}>}}
 *   `value` is the default expression; undefined marks a required prop.
 * @throws {TemplateError} On malformed or mismatched component markup.
 */
function transform(source, {component = false} = {}) {
  const token = new RegExp(TOKEN.source, 'g')
  const stack = []
  const props = []
  let declaredProps = false
  let output = ''
  let last = 0
  let line = 1
  let counted = 0

  const lineAt = index => {
    line += countLines(source, counted, index)
    counted = index
    return line
  }

  const call = (name, attributes, selfClosing, at, tag) => {
    if (!COMPONENT_NAME.test(name)) throw new TemplateError(`Invalid component name "${name}"`, at)
    const head = `html += await __c(${literal(name)}, ${at}, ${attributeList(attributes, at)}, `
    if (selfClosing) return `${head}null);`
    stack.push({kind: 'component', tag, line: at})
    return `${head}async (__provide) => { let html = '';`
  }

  const open = (tag, text, selfClosing, at) => {
    const attributes = parseAttributes(text)
    if (tag.startsWith('c:')) return call(tag.slice(2), attributes, selfClosing, at, tag)

    if (tag === 'odac:component') {
      const {name, rest} = staticName(attributes, tag, at)
      if (name === null) throw new TemplateError('<odac:component> needs a name="..."', at)
      return call(name, rest, selfClosing, at, tag)
    }

    if (tag === 'odac:slot') {
      const name = staticName(attributes, tag, at).name ?? 'default'
      if (!SLOT_NAME.test(name)) throw new TemplateError(`Invalid slot name "${name}"`, at)
      const slot = `slots[${literal(name)}]`
      if (selfClosing) return `html += ${slot} ? await ${slot}() : '';`
      if (stack.at(-1)?.kind === 'component') {
        stack.push({kind: 'provide', tag, line: at})
        return `__provide(${literal(name)}, async () => { let html = '';`
      }
      stack.push({kind: 'slot', tag, line: at})
      return `if (${slot}) { html += await ${slot}(); } else {`
    }

    // odac:props
    if (!component) throw new TemplateError('<odac:props> is only allowed in components (view/components/)', at)
    if (!selfClosing) throw new TemplateError('<odac:props> must be self-closing: <odac:props ... />', at)
    if (stack.length > 0 || declaredProps) throw new TemplateError('<odac:props> must appear once, outside other tags', at)
    declaredProps = true
    for (const {name, value} of attributes) {
      const prop = name.startsWith(':') ? name.slice(1) : name
      if (!isLocalName(prop)) throw new TemplateError(`Invalid prop name "${prop}"`, at)
      if (props.some(declared => declared.name === prop)) throw new TemplateError(`Prop "${prop}" is declared twice`, at)
      if (value !== true && !value.trim()) throw new TemplateError(`Prop "${prop}" has an empty default`, at)
      props.push({name: prop, value: value === true ? undefined : expression(value)})
    }
    return ''
  }

  const close = (tag, at) => {
    const top = stack.pop()
    if (!top) throw new TemplateError(`</${tag}> has no opening tag`, at)
    const matches = top.kind === 'component' ? top.tag === tag : tag === 'odac:slot'
    if (!matches) throw new TemplateError(`</${tag}> does not match <${top.tag}> opened in line ${top.line}`, at)
    return top.kind === 'slot' ? '}' : 'return html; });'
  }

  let match
  while ((match = token.exec(source))) {
    if (match[1]) continue
    const at = lineAt(match.index)
    const end = tagEnd(source, token.lastIndex)
    if (end === -1) throw new TemplateError(`${match[0]} is never closed with ">"`, at)

    const tag = match[3] !== undefined ? `c:${match[3]}` : `odac:${match[4]}`
    let text = source.slice(token.lastIndex, end)
    const selfClosing = /\/\s*$/.test(text)
    if (selfClosing) text = text.replace(/\/\s*$/, '')

    let code
    if (match[2]) {
      if (tag === 'odac:props' || selfClosing || text.trim()) throw new TemplateError(`Malformed closing tag </${tag}>`, at)
      code = close(tag, at)
    } else {
      code = open(tag, text, selfClosing, at)
    }

    const newlines = countLines(source, match.index, end)
    const block = code || newlines > 0 ? `<odac:js>${code}${'\n'.repeat(newlines)}</odac:js>` : ''
    output += source.slice(last, match.index) + block
    last = end + 1
    token.lastIndex = end + 1
  }

  const unclosed = stack.pop()
  if (unclosed) throw new TemplateError(`<${unclosed.tag}> is never closed`, unclosed.line)
  return {content: output + source.slice(last), props}
}

module.exports = {TemplateError, transform}
