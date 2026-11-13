const {isLocalName} = require('./Identifiers')

/**
 * Compile-time transform of component markup into template code.
 *
 * Why: component tags nest (a component inside a slot inside a component), and the regex passes
 * of the compiler pair an opening tag with the first closing tag of the same name. This pass
 * walks the tags with a stack instead, so every `</c:card>` closes its own `<c:card>`, and emits
 * each tag as an `<odac:js>` block the compiler then treats like hand-written backend code.
 *
 * - `<c:name attr="..." :prop="expr">children</c:name>` / `<odac:component name="...">` (or
 *   `:is="expr"` for a name chosen at render time) call the `__r` runtime (see Component.js).
 *   Children compile into a closure in the caller's scope, so loop variables and locals of the
 *   page stay available inside slot content.
 * - `<odac:slot name="x">` directly inside a component tag provides a named slot; anywhere else
 *   it outputs the current component's slot, with its children as fallback content.
 * - `<odac:props a="default" b />` declares a component's props (b is required).
 * - `<odac:once>`, `<style once>` and `<script once>` render once per response, however often
 *   the template containing them renders.
 * - `<odac:push to="head">` adds its content to the `<odac:stack name="head" />` of the page.
 * - `lazy` / `lazy="load"` on a component tag renders the component in a second request (see
 *   Lazy.js); the tag's children are the placeholder shown until then, not slot content.
 *
 * The content of plain `<script>` and `<style>` elements is browser code, not markup: component
 * tags inside it are left alone.
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
// Slot and stack names.
const SLOT_NAME = /^[A-Za-z_][\w-]*$/
// Group 1: a region whose content is not markup (backend JS and backend comments) and is skipped.
// Group 2: a `<script>` or `<style>` element. Group 3: `/` of a closing tag.
// Group 4: `c:` component name. Group 5: `odac:` tag name.
const TOKEN =
  /(<script:odac[^>]*>[\s\S]*?<\/script:odac>|<odac:js>[\s\S]*?<\/odac:js>|<!--odac[\s\S]*?(?:odac-->|-->)|\{\{--[\s\S]*?--\}\})|<(script|style)(?=[\s>])|<(\/?)(?:c:([\w.-]+)|odac:(component|slot|props|once|push))(?=[\s/>])/g
// Tags that wrap content and cannot be self-closing.
const CONTAINERS = new Set(['odac:once', 'odac:push'])
const ATTRIBUTE = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g
const SPACED_ATTRIBUTE = new RegExp(`(\\s*)${ATTRIBUTE.source}`, 'g')
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

// The static value of attribute `key` (e.g. name="..."), removed from the attribute list.
function staticAttribute(attributes, key, tag, line) {
  const index = attributes.findIndex(attribute => attribute.name === key)
  if (index === -1) return {value: null, rest: attributes}
  const {value} = attributes[index]
  if (value === true || /\{\{|\{!!/.test(value)) throw new TemplateError(`<${tag}> needs a static ${key}="..."`, line)
  return {value, rest: attributes.filter((_, i) => i !== index)}
}

// The component name as a JS expression, and the attributes left for the component. `<c:name>`
// and name="..." are literals checked here; `:is="expr"` is checked when it renders.
function componentName(tag, attributes, line) {
  if (tag.startsWith('c:')) return {name: checkedName(tag.slice(2), line), rest: attributes}
  const dynamic = attributes.find(attribute => attribute.name === ':is')
  const {value, rest} = staticAttribute(attributes, 'name', tag, line)
  if (dynamic && value !== null) throw new TemplateError('<odac:component> takes name="..." or :is="...", not both', line)
  if (value !== null) return {name: checkedName(value, line), rest}
  if (!dynamic) throw new TemplateError('<odac:component> needs a name="..." or :is="..."', line)
  if (dynamic.value === true || !dynamic.value.trim()) throw new TemplateError('":is" needs an expression', line)
  return {name: `await (${expression(dynamic.value)})`, rest: rest.filter(attribute => attribute !== dynamic)}
}

// `lazy` on a component tag: deferred until visible (`lazy`, `lazy="visible"`) or until the page
// has loaded (`lazy="load"`). Removed from the attributes the component receives.
function lazyMode(attributes, line) {
  const index = attributes.findIndex(attribute => attribute.name === 'lazy' || attribute.name === ':lazy')
  if (index === -1) return {lazy: null, rest: attributes}
  const {name, value} = attributes[index]
  if (name === ':lazy' || (value !== true && value !== 'visible' && value !== 'load')) {
    throw new TemplateError('lazy takes no value, "visible" or "load"', line)
  }
  return {lazy: value === true ? 'visible' : value, rest: attributes.filter((_, i) => i !== index)}
}

function checkedName(name, line) {
  if (!COMPONENT_NAME.test(name)) throw new TemplateError(`Invalid component name "${name}"`, line)
  return literal(name)
}

/**
 * Rewrites component markup into `<odac:js>` blocks.
 * @param {string} source Template markup (after Form and Image transforms).
 * @param {object} [options]
 * @param {boolean} [options.component] The template is a component: `<odac:props>` is allowed.
 * @param {string} [options.file] Template path; identifies its `once` blocks within a response.
 * @returns {{content: string, props: Array<{name: string, value: (string|undefined)}>}}
 *   `value` is the default expression; undefined marks a required prop.
 * @throws {TemplateError} On malformed or mismatched component markup.
 */
function transform(source, {component = false, file = ''} = {}) {
  const token = new RegExp(TOKEN.source, 'g')
  const stack = []
  const props = []
  let declaredProps = false
  let onceBlocks = 0
  const onceId = () => literal(`${file}#${onceBlocks++}`)
  let output = ''
  let last = 0
  let line = 1
  let counted = 0

  const lineAt = index => {
    line += countLines(source, counted, index)
    counted = index
    return line
  }

  // `name` is a JS expression for the component name: a literal, or `:is` checked at render time.
  // A lazy call passes its mode after the children (closed in close()).
  const call = (name, attributes, selfClosing, at, tag, lazy) => {
    const head = `html += await __r.component(${name}, ${at}, ${attributeList(attributes, at)}, `
    const mode = lazy ? `, ${literal(lazy)}` : ''
    if (selfClosing) return `${head}null${mode});`
    stack.push({kind: 'component', tag, line: at, mode})
    return `${head}async (__provide) => { let html = '';`
  }

  const open = (tag, text, selfClosing, at) => {
    const attributes = parseAttributes(text)
    if (CONTAINERS.has(tag) && selfClosing) throw new TemplateError(`<${tag}> needs content and a closing </${tag}>`, at)

    if (tag.startsWith('c:') || tag === 'odac:component') {
      const {name, rest} = componentName(tag, attributes, at)
      const {lazy, rest: passed} = lazyMode(rest, at)
      return call(name, passed, selfClosing, at, tag, lazy)
    }

    if (tag === 'odac:once') {
      stack.push({kind: 'once', tag, line: at})
      return `if (__r.once(${onceId()})) {`
    }

    if (tag === 'odac:push') {
      const {value: name} = staticAttribute(attributes, 'to', tag, at)
      if (name === null) throw new TemplateError('<odac:push> needs a to="..." stack name', at)
      if (!SLOT_NAME.test(name)) throw new TemplateError(`Invalid stack name "${name}"`, at)
      stack.push({kind: 'push', tag, line: at})
      return `await __r.push(${literal(name)}, async () => { let html = '';`
    }

    if (tag === 'odac:slot') {
      const name = staticAttribute(attributes, 'name', tag, at).value ?? 'default'
      if (!SLOT_NAME.test(name)) throw new TemplateError(`Invalid slot name "${name}"`, at)
      const slot = `slots[${literal(name)}]`
      if (selfClosing) return `html += ${slot} ? await ${slot}() : '';`
      if (stack.at(-1)?.kind === 'component') {
        if (stack.at(-1).mode) {
          throw new TemplateError('A lazy component takes no slots: its content is the placeholder shown while it loads', at)
        }
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
    if (top.tag !== tag) throw new TemplateError(`</${tag}> does not match <${top.tag}> opened in line ${top.line}`, at)
    if (top.kind === 'slot' || top.kind === 'once') return '}'
    return `return html; }${top.mode ?? ''});`
  }

  // A <script> or <style> element: its content is skipped; with `once` it renders once.
  const element = (match, name) => {
    const end = tagEnd(source, token.lastIndex)
    if (end === -1) return
    const closing = `</${name}>`
    const closeAt = source.indexOf(closing, end + 1)
    const text = source.slice(token.lastIndex, end)
    const once = parseAttributes(text).some(attribute => attribute.name === 'once')
    if (!once) {
      token.lastIndex = closeAt === -1 ? end + 1 : closeAt + closing.length
      return
    }
    const at = lineAt(match.index)
    if (closeAt === -1) throw new TemplateError(`<${name} once> is never closed`, at)
    // `once` is removed with the whitespace before it; line breaks stay for line alignment.
    const attributes = text.replace(SPACED_ATTRIBUTE, (attribute, space, attributeName) =>
      attributeName === 'once' ? space.replace(/[^\n]/g, '') : attribute
    )
    const opening = `<${name}${attributes}>`
    const after = closeAt + closing.length
    output +=
      source.slice(last, match.index) +
      `<odac:js>if (__r.once(${onceId()})) {</odac:js>${opening}${source.slice(end + 1, after)}<odac:js>}</odac:js>`
    last = after
    token.lastIndex = after
  }

  let match
  while ((match = token.exec(source))) {
    if (match[1]) continue
    if (match[2]) {
      element(match, match[2])
      continue
    }
    const at = lineAt(match.index)
    const end = tagEnd(source, token.lastIndex)
    if (end === -1) throw new TemplateError(`${match[0]} is never closed with ">"`, at)

    const tag = match[4] !== undefined ? `c:${match[4]}` : `odac:${match[5]}`
    let text = source.slice(token.lastIndex, end)
    const selfClosing = /\/\s*$/.test(text)
    if (selfClosing) text = text.replace(/\/\s*$/, '')

    let code
    if (match[3]) {
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
