const nodeCrypto = require('crypto')
const Lazy = require('./Lazy')
const Template = require('./Template')

/**
 * Component runtime: resolves `<c:name>` to `view/components/name.html`, splits attributes into
 * props and pass-through attributes, collects slots and renders the component in its own scope.
 *
 * Why: components are compiled to their own modules and called at render time instead of being
 * inlined into the page. A changed component recompiles alone, a component may render itself
 * (trees, menus), and its scope holds only its props, so it renders the same wherever it is used.
 */

// Where page components live; mail templates pass their own directory (view/mail/components).
const DIRECTORY = './view/components'
const NAME = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/
// Deep enough for real trees, shallow enough to stop a component that renders itself forever.
const MAX_DEPTH = 50
// Where `<odac:push to="name">` content is printed: `<odac:stack name="name" />`.
const STACK_MARKER = /<odac:stack\s+name=(["'])([A-Za-z_][\w-]*)\1\s*\/?>(?:\s*<\/odac:stack>)?/g
const ESCAPES = {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}
const EMPTY_SLOTS = Object.freeze(Object.create(null))

const escapeValue = value => String(value).replace(/[&<>"']/g, char => ESCAPES[char])
const camelCase = name => name.replace(/-([a-z0-9])/g, (_, char) => char.toUpperCase())

// An attribute name the HTML tokenizer reads as one name: no whitespace, quotes, `<`, `>`, `/`,
// `=` or control characters. Names reach here from `Odac.View.component()` props as well.
function isAttributeName(name) {
  if (typeof name !== 'string' || name.length === 0) return false
  for (let i = 0; i < name.length; i++) {
    const code = name.charCodeAt(i)
    if (code <= 0x20 || code === 0x7f || '"\'<>/='.includes(name[i])) return false
  }
  return true
}

/**
 * The attributes a component did not declare as props, printed with `{!! attrs !!}`.
 *
 * Why: a component's root element should accept `class`, `id`, `data-*` and `aria-*` from its
 * caller without declaring each one. Values are escaped when printed; `true` prints a bare
 * attribute and `false`/`null`/`undefined` omit it, so `:disabled="locked"` works as expected.
 */
class Attributes {
  #entries

  /** @param {Map<string, *>} [entries] */
  constructor(entries = new Map()) {
    this.#entries = entries
  }

  /** @returns {boolean} Whether the caller passed `name`. */
  has(name) {
    return this.#entries.has(name)
  }

  /** @returns {*} The raw value the caller passed for `name`. */
  get(name) {
    return this.#entries.get(name)
  }

  /** @returns {Attributes} Only the given attributes. */
  only(...names) {
    return new Attributes(new Map([...this.#entries].filter(([name]) => names.includes(name))))
  }

  /** @returns {Attributes} Every attribute except the given ones. */
  except(...names) {
    return new Attributes(new Map([...this.#entries].filter(([name]) => !names.includes(name))))
  }

  /**
   * Merges the component's own classes with the caller's `class`.
   * Why: printing `class="btn"` next to `{!! attrs !!}` would emit two class attributes and the
   * browser keeps only the first.
   * @param {string} base The component's classes.
   * @returns {Attributes}
   */
  class(base) {
    const own = this.#entries.get('class')
    const value = [base, typeof own === 'string' || typeof own === 'number' ? own : '']
      .map(part => String(part ?? '').trim())
      .filter(Boolean)
      .join(' ')
    const rest = [...this.#entries].filter(([name]) => name !== 'class')
    return new Attributes(new Map([['class', value], ...rest]))
  }

  toString() {
    const printed = []
    for (const [name, value] of this.#entries) {
      if (value === false || value === null || value === undefined || !isAttributeName(name)) continue
      printed.push(value === true ? name : `${name}="${escapeValue(value)}"`)
    }
    return printed.join(' ')
  }
}

const EMPTY_ATTRIBUTES = new Attributes()

/**
 * Per-response state shared by every template of one render: the `once` blocks already printed
 * and the content pushed to each stack (insertion-ordered, identical pushes kept once).
 * @returns {{once: Set<string>, stacks: Map<string, Set<string>>}}
 */
function createState() {
  return {once: new Set(), stacks: new Map()}
}

/**
 * The `__r` object a compiled template calls for component tags, `once` blocks and pushes.
 *
 * Why: one runtime per template keeps the template's place in the component chain (for errors
 * and the nesting limit) while sharing the response's `once` and stack state.
 */
class Runtime {
  #scope

  /**
   * @param {object} scope
   * @param {object} scope.odac Request context.
   * @param {Function[]} scope.helpers `[get, __, __x]` passed to every template.
   * @param {string} scope.file Template that contains the tags.
   * @param {string|null} scope.module Compiled module name of `scope.file`.
   * @param {string[]} scope.chain Templates that rendered `scope.file`, nearest first.
   * @param {Set<string>} scope.seen Templates checked for changes in this response.
   * @param {object} scope.state Shared response state (see createState()).
   * @param {string} [scope.directory] Component directory, `./view/components` by default.
   * @param {boolean} [scope.lazy] False where no browser loads lazy components (mail).
   */
  constructor(scope) {
    this.#scope = scope
  }

  /** Renders `<c:name>`, or the placeholder of `<c:name lazy>` (`lazy` is its mode). */
  component(name, line, attributes, children, lazy) {
    if (lazy) return deferred(this.#scope, name, line, attributes, children, lazy)
    return render(this.#scope, name, line, attributes, children)
  }

  /** @returns {boolean} True the first time block `id` renders in this response. */
  once(id) {
    const printed = this.#scope.state.once
    if (printed.has(id)) return false
    printed.add(id)
    return true
  }

  /**
   * Renders `<odac:push to="stack">` content where it appears (in the template's scope) and
   * keeps it for the page's `<odac:stack name="stack" />`.
   */
  async push(stack, renderContent) {
    const html = (await renderContent()).trim()
    if (!html) return
    const stacks = this.#scope.state.stacks
    if (!stacks.has(stack)) stacks.set(stack, new Set())
    stacks.get(stack).add(html)
  }
}

function split(attributes, declared) {
  const props = Object.create(null)
  const passed = new Map()
  for (const [name, value] of attributes) {
    const prop = camelCase(name)
    if (prop === '__proto__') continue
    props[prop] = value
    if (!declared.has(prop)) passed.set(name, value)
  }
  return {props, attrs: passed.size > 0 ? new Attributes(passed) : EMPTY_ATTRIBUTES}
}

// Runs the caller's children: the loose content becomes the default slot and each
// `<odac:slot name>` registers a named slot that renders when the component prints it.
async function slots(scope, children) {
  if (!children) return EMPTY_SLOTS
  const collected = Object.create(null)
  // Slot content is the caller's code; its failures are reported in the caller's template.
  const guard =
    renderSlot =>
    async (...args) => {
      try {
        return (await renderSlot(...args)).trim()
      } catch (e) {
        throw Template.failure(e, {file: scope.file, module: scope.module, chain: scope.chain})
      }
    }
  const content = (
    await children((name, renderSlot) => {
      collected[name] = guard(renderSlot)
    })
  ).trim()
  if (content && !collected.default) collected.default = async () => content
  return collected
}

// Finds and loads a component; checks its name, the nesting limit and its required props.
async function resolve(scope, name, line, attributes) {
  const origin = {file: scope.file, line, chain: scope.chain}
  if (typeof name !== 'string' || !NAME.test(name)) throw Template.failure(new Error(`Invalid component name "${name}"`), origin)
  if (scope.chain.length >= MAX_DEPTH) {
    throw Template.failure(new Error(`Components are nested more than ${MAX_DEPTH} levels deep at "${name}"`), origin)
  }

  const file = `${scope.directory ?? DIRECTORY}/${name.replace(/\./g, '/')}.html`
  const chain = [scope.file, ...scope.chain]
  const component = await Template.load(file, scope.odac, {component: true, seen: scope.seen, chain})
  if (!component) throw Template.failure(new Error(`Component "${name}" not found (${file})`), origin)

  const {props, attrs} = split(attributes, component.declared)
  const missing = component.required.find(prop => props[prop] === undefined)
  if (missing !== undefined) throw Template.failure(new Error(`Component "${name}" requires the "${missing}" prop`), origin)
  return {origin, file, chain, component, props, attrs}
}

async function render(scope, name, line, attributes, children) {
  const {file, chain, component, props, attrs} = await resolve(scope, name, line, attributes)
  const collected = await slots(scope, children)
  const nested = new Runtime({...scope, file, module: component.name, chain})
  try {
    return await component.fn(scope.odac, ...scope.helpers, nested, props, attrs, collected)
  } catch (e) {
    throw Template.failure(e, {file, module: component.name, chain})
  }
}

/**
 * Renders the placeholder of a lazy component: an `<odac-lazy>` element holding the token the
 * browser sends to `/_odac/lazy`, around the tag's children (shown until the component loads).
 * Why: the component and its required props are checked now, so a typo fails the page that
 * contains it instead of a request the browser makes later.
 */
async function deferred(scope, name, line, attributes, children, mode) {
  const {origin} = await resolve(scope, name, line, attributes)
  if (scope.lazy === false) throw Template.failure(new Error(`Component "${name}" cannot be lazy here: no browser loads it`), origin)

  // The children are the placeholder: the default slot, rendered now in the caller's scope.
  const collected = await slots(scope, children)
  const placeholder = collected.default ? await collected.default() : ''
  let token
  try {
    const lang = scope.odac.Lang?.current?.() ?? null
    token = await Lazy.seal(scope.odac, {name, attributes, user: Lazy.user(scope.odac), lang})
  } catch (e) {
    throw Template.failure(e, origin)
  }
  const when = mode === 'load' ? ' data-odac-when="load"' : ''
  return `<odac-lazy data-odac-lazy="${token}"${when}>${placeholder}</odac-lazy>`
}

/**
 * The content pushed in this response, per stack, each item with a key derived from its HTML.
 * Why: the browser keeps the keys of what a page already has and inserts only new items when
 * AJAX navigation brings the pushes of the next page.
 * @param {object} state Response state (see createState()).
 * @returns {Object<string, Array<{key: string, html: string}>>|null} null when nothing was pushed.
 */
function stackItems(state) {
  if (state.stacks.size === 0) return null
  const stacks = {}
  for (const [name, items] of state.stacks) {
    stacks[name] = [...items].map(html => ({key: nodeCrypto.hash('sha1', html).slice(0, 16), html}))
  }
  return stacks
}

/**
 * Replaces `<odac:stack name="..." />` markers with the content pushed to them.
 *
 * Why: a component used in the page body needs its CSS in `<head>` or its script before
 * `</body>`, which render before or outside the component. Markers are filled after every part
 * has rendered, so a push from any part reaches any marker. In a page each marker becomes an
 * inert `<template data-odac-stack>` holding the keys of what precedes it, where AJAX navigation
 * inserts the pushes of the next page that are not on the page yet. Only the first marker of a
 * name is filled; repeats are removed.
 * @param {string} html Rendered page, part or mail.
 * @param {object} state Response state (see createState()).
 * @param {object} [options]
 * @param {boolean} [options.content] Print the pushed items. A part sent to the browser omits
 *   them: the browser inserts them from the response's `stacks`.
 * @param {boolean} [options.marker] Leave the `<template>` marker (pages; not mail).
 * @returns {string}
 */
function fillStacks(html, state, {content = true, marker = true} = {}) {
  if (!html.includes('<odac:stack')) return html
  const items = content ? stackItems(state) : null
  const filled = new Set()
  return html.replace(STACK_MARKER, (match, quote, name) => {
    if (filled.has(name)) return ''
    filled.add(name)
    const pushed = items?.[name] ?? []
    const printed = pushed.map(item => item.html).join('\n')
    if (!marker) return printed
    const keys = pushed.map(item => item.key).join(' ')
    return `${printed}<template data-odac-stack="${name}" data-odac-keys="${keys}"></template>`
  })
}

module.exports = {Attributes, EMPTY_ATTRIBUTES, EMPTY_SLOTS, Runtime, createState, fillStacks, render, stackItems}
