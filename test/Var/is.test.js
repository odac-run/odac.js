const Var = require('../../src/Var')

// is('json') must return a boolean: true for valid JSON, false for invalid —
// never throw. See IMPROVEMENT-PLAN 2.5.

describe("Var.is('json')", () => {
  it('returns true for a valid JSON object', () => {
    expect(new Var('{"a":1}').is('json')).toBe(true)
  })

  it('returns true for a valid JSON array', () => {
    expect(new Var('[1,2,3]').is('json')).toBe(true)
  })

  it('returns false for invalid JSON without throwing', () => {
    expect(() => new Var('{not json}').is('json')).not.toThrow()
    expect(new Var('{not json}').is('json')).toBe(false)
  })

  it('returns false for a bare non-JSON string', () => {
    expect(new Var('hello').is('json')).toBe(false)
  })

  it('returns false for an empty string', () => {
    expect(new Var('').is('json')).toBe(false)
  })
})

describe("Var.is('emoji')", () => {
  it.each(['😀', 'hi 👋', '🇹🇷', '1️⃣', '❤️'])('detects %s', value => {
    expect(new Var(value).is('emoji')).toBe(true)
  })

  it.each(['abc', 'ἀ0', 'Zürich 2024', ''])('does not flag %s', value => {
    expect(new Var(value).is('emoji')).toBe(false)
  })
})

describe("Var.is('url')", () => {
  it.each(['https://my-site.com', 'http://localhost:3000', 'https://example.com/path?q=1', 'wss://example.com/socket'])(
    'accepts %s',
    value => {
      expect(new Var(value).is('url')).toBe(true)
    }
  )

  it.each(['javascript:alert(1)', 'data:text/html,x', 'http:example.com', 'https://exa mple.com', 'example.com', 'file:///etc/passwd'])(
    'rejects %s',
    value => {
      expect(new Var(value).is('url')).toBe(false)
    }
  )
})

describe("Var.is('domain')", () => {
  it.each(['example.com', 'my-site.technology', 'a.b.c.example.co.uk', 'xn--80ak6aa92e.xn--p1ai'])('accepts %s', value => {
    expect(new Var(value).is('domain')).toBe(true)
  })

  it.each(['localhost', '-bad.com', 'bad-.com', 'a..com', 'exa_mple.com', `${'a'.repeat(64)}.com`])('rejects %s', value => {
    expect(new Var(value).is('domain')).toBe(false)
  })
})

describe("Var.is('ip')", () => {
  it.each(['192.168.1.1', '::1', '2001:db8::1'])('accepts %s', value => {
    expect(new Var(value).is('ip')).toBe(true)
  })

  it.each(['999.999.999.999', '1.2.3', '1.2.3.4.5', 'abc'])('rejects %s', value => {
    expect(new Var(value).is('ip')).toBe(false)
  })
})
