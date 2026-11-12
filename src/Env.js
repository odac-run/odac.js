const fsPromises = require('fs').promises

const ESCAPES = {n: '\n', r: '\r', t: '\t', '"': '"', '\\': '\\'}

module.exports = {
  /**
   * Loads `<dir>/.env` into process.env without overriding variables the process already has.
   * Why: secrets belong in .env, but values set by the host (systemd, Docker, CI) must win so a
   * deploy can override a committed default without editing the file.
   */
  init: async function (dir) {
    const envPath = (dir || __dir) + '/.env'
    let content
    try {
      content = await fsPromises.readFile(envPath, 'utf8')
    } catch (err) {
      if (err.code !== 'ENOENT') console.error('Error reading .env file:', err.message)
      return
    }

    const vars = this.parse(content)
    for (const key of Object.keys(vars)) {
      if (process.env[key] === undefined) process.env[key] = vars[key]
    }
  },

  /**
   * Parses .env content into a plain key/value map.
   * Why: follows the shell/Docker Compose rules developers expect, so a password such as
   * `ab#cd` is not cut at `#` (a comment starts only at a `#` preceded by whitespace), quoted
   * values may span lines and `export KEY=value` lines copied from shell scripts work.
   * @param {string} content Raw file content.
   * @returns {Object<string, string>}
   */
  parse: function (content) {
    const result = Object.create(null)
    const lines = content.replace(/\r\n?/g, '\n').split('\n')

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim()
      if (!line || line.startsWith('#')) continue

      const body = line.replace(/^export\s+/, '')
      const separatorIndex = body.indexOf('=')
      if (separatorIndex <= 0) continue

      const key = body.slice(0, separatorIndex).trim()
      if (!key) continue

      const raw = body.slice(separatorIndex + 1)
      const quote = raw.trimStart()[0]

      if (quote === '"' || quote === "'") {
        const parsed = this._readQuoted(raw.trimStart(), quote, lines, i)
        if (parsed) {
          result[key] = parsed.value
          i = parsed.lastLine
          continue
        }
      }

      result[key] = this._parseValue(raw)
    }

    return result
  },

  /**
   * Reads a quoted value starting at `start`, continuing onto following lines until the
   * closing quote. Returns null when the quote is never closed so the line falls back to the
   * unquoted rules instead of swallowing the rest of the file.
   */
  _readQuoted: function (start, quote, lines, lineIndex) {
    let text = start.slice(1)
    let index = lineIndex

    for (;;) {
      const end = this._closingQuote(text, quote)
      if (end !== -1) {
        const inner = text.slice(0, end)
        const value = quote === '"' ? inner.replace(/\\([nrt"\\])/g, (_, c) => ESCAPES[c]) : inner
        return {value, lastLine: index}
      }
      if (++index >= lines.length) return null
      text += '\n' + lines[index]
    }
  },

  _closingQuote: function (text, quote) {
    for (let i = 0; i < text.length; i++) {
      if (quote === '"' && text[i] === '\\') {
        i++
        continue
      }
      if (text[i] === quote) return i
    }
    return -1
  },

  /**
   * Unquoted value: an inline comment starts only at a `#` preceded by whitespace.
   */
  _parseValue: function (value) {
    const comment = value.search(/\s#/)
    return (comment === -1 ? value : value.slice(0, comment)).trim()
  },

  get: function (key, defaultValue) {
    return process.env[key] !== undefined ? process.env[key] : defaultValue
  }
}
