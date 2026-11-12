const {parseRange} = require('../../../src/Route/StaticFile')

describe('StaticFile.parseRange()', () => {
  it('returns null without a usable header so the full body is served', () => {
    expect(parseRange(undefined, 10)).toBeNull()
    expect(parseRange('bytes=-', 10)).toBeNull()
    expect(parseRange('items=0-1', 10)).toBeNull()
    expect(parseRange('bytes=0-1,3-4', 10)).toBeNull()
  })

  it('parses closed, open-ended and suffix ranges', () => {
    expect(parseRange('bytes=0-0', 10)).toEqual({start: 0, end: 0})
    expect(parseRange('bytes=4-', 10)).toEqual({start: 4, end: 9})
    expect(parseRange('bytes=-4', 10)).toEqual({start: 6, end: 9})
  })

  it('clamps an end or suffix beyond the file size', () => {
    expect(parseRange('bytes=5-100', 10)).toEqual({start: 5, end: 9})
    expect(parseRange('bytes=-100', 10)).toEqual({start: 0, end: 9})
  })

  it('reports unsatisfiable ranges as false', () => {
    expect(parseRange('bytes=10-', 10)).toBe(false)
    expect(parseRange('bytes=5-2', 10)).toBe(false)
    expect(parseRange('bytes=-0', 10)).toBe(false)
    expect(parseRange('bytes=0-', 0)).toBe(false)
  })
})
