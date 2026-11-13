const Template = require('./Template')

/**
 * Component runtime: resolves `<c:name>` to `view/components/name.html`, splits attributes into
 * props and pass-through attributes, collects slots and renders the component in its own scope.
 *
 * Why: components are compiled to their own modules and called at render time instead of being
 * inlined into the page. A changed component recompiles alone, a component may render itself
 * (trees, menus), and its scope holds only its props, so it renders the same wherever it is used.
 */

const DIRECTORY = './view/components'
const NAME = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/
// Deep enough for real trees, shallow enough to stop a component that renders itself forever.
const MAX_DEPTH = 50
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
 * Creates the `__c` function a compiled template calls for each component tag.
 * @param {object} scope
 * @param {object} scope.odac Request context.
 * @param {Function[]} scope.helpers `[get, __, __x]` passed to every template.
 * @param {string} scope.file Template that contains the component tags.
 * @param {string|null} scope.module Compiled module name of `scope.file`.
 * @param {string[]} scope.chain Templates that rendered `scope.file`, nearest first.
 * @param {Set<string>} scope.seen Templates checked for changes in this request.
 * @returns {Function}
 */
function caller(scope) {
  return (name, line, attributes, children) => render(scope, name, line, attributes, children)
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

async function render(scope, name, line, attributes, children) {
  const origin = {file: scope.file, line, chain: scope.chain}
  if (typeof name !== 'string' || !NAME.test(name)) throw Template.failure(new Error(`Invalid component name "${name}"`), origin)
  if (scope.chain.length >= MAX_DEPTH) {
    throw Template.failure(new Error(`Components are nested more than ${MAX_DEPTH} levels deep at "${name}"`), origin)
  }

  const file = `${DIRECTORY}/${name.replace(/\./g, '/')}.html`
  const chain = [scope.file, ...scope.chain]
  const component = await Template.load(file, scope.odac, {component: true, seen: scope.seen, chain})
  if (!component) throw Template.failure(new Error(`Component "${name}" not found (${file})`), origin)

  const {props, attrs} = split(attributes, component.declared)
  const missing = component.required.find(prop => props[prop] === undefined)
  if (missing !== undefined) throw Template.failure(new Error(`Component "${name}" requires the "${missing}" prop`), origin)

  const collected = await slots(scope, children)
  const nested = caller({...scope, file, module: component.name, chain})
  try {
    return await component.fn(scope.odac, ...scope.helpers, nested, props, attrs, collected)
  } catch (e) {
    throw Template.failure(e, {file, module: component.name, chain})
  }
}

module.exports = {Attributes, EMPTY_ATTRIBUTES, EMPTY_SLOTS, caller, render}
