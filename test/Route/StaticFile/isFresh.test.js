const {isFresh, isHidden, cacheControl} = require('../../../src/Route/StaticFile')

const headers = values => name => values[name]

describe('StaticFile.isFresh()', () => {
  const tag = 'W/"a-1"'
  const mtimeMs = Date.parse('Wed, 11 Nov 2026 10:00:00 GMT') + 400

  it('matches If-None-Match weakly, in lists and with *', () => {
    expect(isFresh(headers({'if-none-match': 'W/"a-1"'}), tag, mtimeMs)).toBe(true)
    expect(isFresh(headers({'if-none-match': '"a-1"'}), tag, mtimeMs)).toBe(true)
    expect(isFresh(headers({'if-none-match': '"x", W/"a-1"'}), tag, mtimeMs)).toBe(true)
    expect(isFresh(headers({'if-none-match': '*'}), tag, mtimeMs)).toBe(true)
    expect(isFresh(headers({'if-none-match': 'W/"a-2"'}), tag, mtimeMs)).toBe(false)
  })

  it('lets If-None-Match take precedence over If-Modified-Since', () => {
    const values = {'if-none-match': 'W/"other"', 'if-modified-since': 'Wed, 11 Nov 2026 10:00:00 GMT'}
    expect(isFresh(headers(values), tag, mtimeMs)).toBe(false)
  })

  it('compares If-Modified-Since at one-second resolution', () => {
    expect(isFresh(headers({'if-modified-since': 'Wed, 11 Nov 2026 10:00:00 GMT'}), tag, mtimeMs)).toBe(true)
    expect(isFresh(headers({'if-modified-since': 'Wed, 11 Nov 2026 09:59:59 GMT'}), tag, mtimeMs)).toBe(false)
    expect(isFresh(headers({'if-modified-since': 'not a date'}), tag, mtimeMs)).toBe(false)
    expect(isFresh(headers({}), tag, mtimeMs)).toBe(false)
  })
})

describe('StaticFile.isHidden()', () => {
  it('flags dotfiles and dot-directories except .well-known', () => {
    expect(isHidden('.env')).toBe(true)
    expect(isHidden('assets/.git/HEAD')).toBe(true)
    expect(isHidden('.well-known/acme-challenge/x')).toBe(false)
    expect(isHidden('assets/app.min.js')).toBe(false)
  })
})

describe('StaticFile.cacheControl()', () => {
  it('only treats a v= query parameter as a version', () => {
    expect(cacheControl('/app.css?v=3')).toContain('immutable')
    expect(cacheControl('/app.css?x=1&v=3')).toContain('immutable')
    expect(cacheControl('/app.css?dev=1')).not.toContain('immutable')
    expect(cacheControl('/app.css?v=')).not.toContain('immutable')
    expect(cacheControl('/app.css')).not.toContain('immutable')
  })
})
