const nodeCrypto = require('crypto')
const {TemplateError, transform} = require('./ComponentSyntax')

/**
 * Template compiler shared by View and Mail.
 *
 * Why: Mail carried a ~250-line copy of the View compiler that had drifted (no `in` loops,
 * unescaped `get` attributes, JS blocks restored in a different order, string replacers
 * that expanded `$&` in templates). One compiler keeps both template dialects identical.
 *
 * compile() turns template markup into the body of an async function that appends to a
 * local `html` variable; the caller wraps it with its own parameters.
 */

const FUNCTIONS = {
  '{!!': {
    function: '${await ',
    close: '!!}',
    end: '}'
  },
  '{{--': {
    function: '`; /*',
    close: '--}}',
    end: '*/ html += `'
  },
  '{{': {
    function: '${Odac.Var(await ',
    close: '}}',
    end: ').html().replace(/\\n/g, "<br>")}'
  },
  break: {
    function: 'break;',
    arguments: {}
  },
  continue: {
    function: 'continue;',
    arguments: {}
  },
  mysql: {
    // TODO: Implement mysql
  },
  elseif: {
    function: '} else if(await ($condition)){',
    arguments: {
      condition: true
    }
  },
  else: {
    function: '} else {'
  },
  fetch: {
    // TODO: Implement fetch
    //  <odac:fetch fetch="/get/products" as="data" method="GET" headers="{}" body="null" refresh="false">
  },
  for: {
    function: '{ let _arr = $constructor; for(let $key in _arr){ let $value = _arr[$key];',
    end: '}}',
    arguments: {
      in: null,
      var: null,
      get: null,
      key: 'key',
      value: 'value'
    }
  },
  if: {
    function: 'if(await ($condition)){',
    arguments: {
      condition: true
    }
  },
  '<odac:js>': {
    end: ' html += `',
    function: '`; ',
    close: '</odac:js>'
  },
  list: {
    arguments: {
      in: null,
      var: null,
      get: null,
      key: 'key',
      value: 'value'
    },
    end: '}}',
    function: '{ let _arr = $constructor; for(let $key in _arr){ let $value = _arr[$key];',
    replace: 'ul'
  },
  while: {
    function: 'while(await ($condition)){',
    arguments: {
      condition: true
    }
  }
}

function parseOdacTag(content) {
  // Parse backend comments
  // Multi-line: <!--odac ... odac-->
  // Single-line: <!--odac ... -->
  content = content.replace(/<!--odac([\s\S]*?)(?:odac-->|-->)/g, () => {
    return ''
  })

  // Parse <script:odac> tags (IDE-friendly JavaScript with backend execution)
  content = content.replace(/<script:odac([^>]*)>([\s\S]*?)<\/script:odac>/g, (fullMatch, attributes, jsContent) => {
    return `<odac:js>${jsContent}</odac:js>`
  })

  content = content.replace(/<odac:else\s*\/>/g, '<odac:else>')
  content = content.replace(/<odac:elseif\s+([^>]*?)\/>/g, '<odac:elseif $1>')

  content = content.replace(/<odac([^>]*?)\/>/g, (fullMatch, attributes) => {
    attributes = attributes.trim()

    const attrs = {}
    const attrRegex = /(\w+)(?:=(["'])((?:(?!\2).)*)\2|=([^\s>]+))?/g
    let match
    while ((match = attrRegex.exec(attributes))) {
      const key = match[1]
      const value = match[3] !== undefined ? match[3] : match[4] !== undefined ? match[4] : true
      attrs[key] = value
    }

    if (attrs.get) {
      const escaped = attrs.get.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
      return attrs.raw ? `{!! get('${escaped}') || '' !!}` : `{{ get('${escaped}') || '' }}`
    } else if (attrs.var) {
      if (attrs.raw) {
        return `{!! ${attrs.var} !!}`
      } else {
        return `{{ ${attrs.var} }}`
      }
    }
    return fullMatch
  })

  let depth = 0
  let maxDepth = 10
  while (depth < maxDepth && content.includes('<odac')) {
    const before = content
    content = content.replace(/<odac([^>]*)>((?:(?!<odac)[\s\S])*?)<\/odac>/g, (fullMatch, attributes, innerContent) => {
      attributes = attributes.trim()
      innerContent = innerContent.trim()

      const attrs = {}
      const attrRegex = /(\w+)(?:=(["'])((?:(?!\2).)*)\2|=([^\s>]+))?/g
      let match
      while ((match = attrRegex.exec(attributes))) {
        const key = match[1]
        const value = match[3] !== undefined ? match[3] : match[4] !== undefined ? match[4] : true
        attrs[key] = value
      }

      if (attrs.get) {
        const escaped = attrs.get.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
        return attrs.raw ? `{!! get('${escaped}') || '' !!}` : `{{ get('${escaped}') || '' }}`
      } else if (attrs.var) {
        if (attrs.raw) {
          return `{!! ${attrs.var} !!}`
        } else {
          return `{{ ${attrs.var} }}`
        }
      } else if (attrs.t || attrs.translate) {
        const placeholders = []
        let processedContent = innerContent
        let placeholderIndex = 1

        processedContent = processedContent.replace(/\{\{([^}]+)\}\}/g, (match, variable) => {
          variable = variable.trim()
          if (variable.startsWith("'") && variable.endsWith("'")) {
            placeholders.push(variable)
          } else {
            placeholders.push(`Odac.Var(await ${variable}).html().replace(/\\n/g, "<br>")`)
          }
          return `%s${placeholderIndex++}`
        })

        processedContent = processedContent.replace(/\{!!([^}]+)!!}/g, (match, variable) => {
          placeholders.push(`await ${variable.trim()}`)
          return `%s${placeholderIndex++}`
        })

        const escapedContent = escapeLiteral(processedContent)
        // context="..." selects one translation of text that means different things in
        // different places; it becomes part of the entry's identity (see Lang#getx).
        const context = typeof attrs.context === 'string' ? attrs.context.trim() : ''
        const args = [`'${escapedContent}'`]
        if (context) args.push(`'${escapeLiteral(context)}'`)
        args.push(...placeholders)
        const translationCall = `${context ? '__x' : '__'}(${args.join(', ')})`

        if (attrs.raw) {
          return `{!! ${translationCall} !!}`
        } else {
          return `{{ ${translationCall} }}`
        }
      } else {
        return `{{ '${innerContent.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}' }}`
      }
    })
    if (before === content) break
    depth++
  }

  return content
}

// Escapes text for a single-quoted JavaScript string literal in compiled view code.
function escapeLiteral(text) {
  return text.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
}

/**
 * Compiles template markup into JavaScript statements that build `html`.
 * @param {string} content Template markup (after any caller-specific pre-processing).
 * @param {object} [options]
 * @param {string} [options.file] Template path, used in compile error messages.
 * @returns {string}
 */
function compile(content, {file = ''} = {}) {
  // Lift backend JS bodies out of the template before any escaping runs, so
  // user JS keeps its literal backslashes, backticks and ${...} sequences.
  // Both spellings are covered: <script:odac> (IDE-friendly) and the raw
  // <odac:js> tag it is rewritten to by #parseOdacTag.
  const jsBlocks = []
  content = content.replace(/<script:odac([^>]*)>([\s\S]*?)<\/script:odac>/g, (match, attrs, jsContent) => {
    const placeholder = `___ODAC_JS_BLOCK_${jsBlocks.length}___`
    jsBlocks.push(jsContent)
    return `<script:odac${attrs}>${placeholder}</script:odac>`
  })
  content = content.replace(/<odac:js>([\s\S]*?)<\/odac:js>/g, (match, jsContent) => {
    const placeholder = `___ODAC_JS_BLOCK_${jsBlocks.length}___`
    jsBlocks.push(jsContent)
    return `<odac:js>${placeholder}</odac:js>`
  })

  content = parseOdacTag(content)
  // Escape template literal meta-characters so raw HTML can be safely
  // embedded in a JS backtick string. Backslashes must be escaped FIRST
  // (CWE-116), but ONLY in plain HTML segments — the {{ }}/{!! !!}
  // expression blocks produced by #parseOdacTag already handle their own
  // backslash escaping internally (see lines 318/348/376/386).
  const exprBlocks = []
  content = content.replace(/\{\{[\s\S]*?\}\}|\{!![\s\S]*?!!\}/g, block => {
    const placeholder = `___ODAC_EXPR_${exprBlocks.length}___`
    exprBlocks.push(block)
    return placeholder
  })
  content = content.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\${/g, '\\${')
  exprBlocks.forEach((block, index) => {
    content = content.replace(`___ODAC_EXPR_${index}___`, () => block)
  })

  let result = 'html += `\n' + content + '\n`'
  for (let key in FUNCTIONS) {
    let att = ''
    let func = FUNCTIONS[key]
    let matches = func.close
      ? result.match(new RegExp(`${key}[\\s\\S]*?${func.close}`, 'g'))
      : result.match(new RegExp(`<odac:${key}(?:\\s+[^>]*?(?:"[^"]*"|'[^']*'|[^"'>])*)?>`, 'g'))
    if (!matches) continue
    for (let match of matches) {
      let matchForParsing = match
      if (!func.close) matchForParsing = matchForParsing.replace(/^<odac:/, '').replace(/>$/, '')
      const attrRegex = /(\w+)(?:=(["'])((?:(?!\2).)*)\2|=([^\s>]+))?/g
      let attrMatch
      const args = []
      while ((attrMatch = attrRegex.exec(matchForParsing))) {
        args.push(attrMatch[0])
      }
      let vars = {}
      if (func.arguments)
        for (let arg of args) {
          const argRegex = /(\w+)(?:=(["'])((?:(?!\2).)*)\2|=([^\s>]+))?/
          const argMatch = argRegex.exec(arg)
          if (!argMatch) continue
          const argKey = argMatch[1]
          const value = argMatch[3] !== undefined ? argMatch[3] : argMatch[4] !== undefined ? argMatch[4] : true
          if (func.arguments[argKey] === undefined) {
            att += `${argKey}="${value}"`
            continue
          }
          vars[argKey] = value
        }
      if (!func.function) continue
      let fun = func.function

      if (key === 'for' || key === 'list') {
        if (!vars.var && !vars.get && !vars.in) {
          console.error(`"var", "get" or "in" is required for "${match}"\n  in "${file}"`)
          continue
        }
        let constructor
        if (vars.in) {
          constructor = `await ${vars.in}`
        } else if (vars.var) {
          constructor = `await ${vars.var}`
        } else if (vars.get) {
          constructor = `get('${vars.get}')`
        }
        fun = fun.replace(/\$constructor/g, () => constructor)
      }

      for (let argKey in func.arguments) {
        // Loop sources are validated and consumed above as $constructor, not as $-placeholders.
        if (argKey === 'in' || argKey === 'var' || argKey === 'get') continue
        if (vars[argKey] === undefined) vars[argKey] = func.arguments[argKey]
        const argValue = vars[argKey]
        fun = fun.replace(new RegExp(`\\$${argKey}`, 'g'), () => argValue)
      }
      if (func.close) {
        const replacement = fun + match.substring(key.length, match.length - func.close.length) + func.end
        result = result.replace(match, () => replacement)
      } else {
        const opening = (func.replace ? `<${[func.replace, att].join(' ')}>` : '') + '`; ' + fun + ' html += `'
        const closing = '`; ' + (func.end ?? '}') + ' html += `' + (func.replace ? `</${func.replace}>` : '')
        result = result.replace(match, () => opening)
        result = result.replace(`</odac:${key}>`, () => closing)
      }
    }
  }

  // Restore backend JS bodies after function processing so the regex
  // pipeline above never sees user JS as template syntax. Use a function
  // replacer to keep $-sequences in the JS literal (e.g. $$, $&) intact.
  // The block is followed by generated code, so terminate its last statement.
  // ';' keeps compiled lines aligned with the view for error reporting; only a
  // possible trailing // comment needs a real newline to end it.
  jsBlocks.forEach((jsContent, index) => {
    const terminator = jsContent.slice(jsContent.lastIndexOf('\n') + 1).includes('//') ? '\n' : ';'
    result = result.replace(`___ODAC_JS_BLOCK_${index}___`, () => jsContent + terminator)
  })
  return result
}

/**
 * Compiles a view or component template.
 *
 * Why: component markup needs a stack-based pass before the regex pipeline of compile(), and a
 * component's `<odac:props>` declaration has to reach the module wrapper. Mail keeps calling
 * compile() directly, where component tags stay plain text.
 * @param {string} content Template markup.
 * @param {object} [options]
 * @param {string} [options.file] Template path, used in compile error messages.
 * @param {boolean} [options.components] Compile `<c:*>`, `<odac:component>` and `<odac:slot>`.
 * @param {boolean} [options.component] The template is a component (`<odac:props>` allowed).
 * @returns {{code: string, props: Array<{name: string, value: (string|undefined)}>}}
 * @throws {TemplateError} On malformed component markup.
 */
function compileTemplate(content, {file = '', components = false, component = false} = {}) {
  let props = []
  let propsLine
  if (components) ({content, props, propsLine} = transform(content, {component, file}))
  return {code: compile(content, {file}), props, propsLine}
}

/** Stable cache file name for a compiled template. */
function cacheName(...parts) {
  return nodeCrypto.createHash('md5').update(parts.join('\u0000')).digest('hex')
}

module.exports = {cacheName, compile, compileTemplate, TemplateError}
