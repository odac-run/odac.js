/**
 * Names a compiled template may declare as local variables.
 *
 * Why: View, Mail and components turn data keys (`Odac.set()` keys, mail data, component props)
 * into template locals so `{{ name }}` works. A key only becomes a local when it is a plain
 * identifier that neither shadows the compiled function's own parameters nor is a reserved
 * word; anything else would break the generated module or let a key rewrite template code.
 * One list keeps every template dialect in agreement.
 */

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/

// The compiled function's parameters and helpers, followed by JavaScript reserved words.
const RESERVED = new Set(
  (
    'Odac data get __ __x __c slots __provide props attrs html ' +
    'arguments await break case catch class const continue debugger default delete do else enum eval ' +
    'export extends false finally for function if implements import in instanceof interface let new null package private ' +
    'protected public return static super switch this throw true try typeof undefined var void while with yield'
  ).split(' ')
)

/**
 * @param {string} name
 * @returns {boolean} Whether `name` can be declared as a template local.
 */
function isLocalName(name) {
  return typeof name === 'string' && IDENTIFIER.test(name) && !RESERVED.has(name)
}

module.exports = {isLocalName}
