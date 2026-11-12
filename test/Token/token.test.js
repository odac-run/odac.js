const Token = require('../../src/Token')

// Two workers serving the same session see each other's writes only once committed. Each
// fake request reads its own uncommitted writes first, then the shared committed store.
function worker(committed) {
  const pending = new Map()
  return {
    pending,
    commit: () => {
      for (const [key, value] of pending) value === null ? committed.delete(key) : committed.set(key, value)
      pending.clear()
    },
    session(key, value) {
      if (value === undefined) return pending.has(key) ? pending.get(key) : (committed.get(key) ?? null)
      pending.set(key, value)
    }
  }
}

describe('Token', () => {
  let committed

  beforeEach(() => {
    committed = new Map()
  })

  it('keeps tokens issued for the same session by two workers at once', () => {
    const a = worker(committed)
    const b = worker(committed)
    const first = new Token(a).generate()
    const second = new Token(b).generate()
    a.commit()
    b.commit()

    const checker = worker(committed)
    expect(new Token(checker).check(first)).toBe(true)
    expect(new Token(checker).check(second)).toBe(true)
  })

  it('accepts a token once', () => {
    const request = worker(committed)
    const token = new Token(request).generate()
    request.commit()

    expect(new Token(request).check(token)).toBe(true)
    request.commit()
    expect(new Token(worker(committed)).check(token)).toBe(false)
  })

  it('rejects an expired token', () => {
    const request = worker(committed)
    const token = new Token(request).generate()
    request.commit()
    committed.set(`_token:${token}`, Date.now() - 1)

    expect(new Token(request).check(token)).toBe(false)
  })

  it('rejects malformed and unknown tokens', () => {
    const token = new Token(worker(committed))
    for (const value of [undefined, null, '', 'abc', {}, 'f'.repeat(64)]) expect(token.check(value)).toBe(false)
  })

  it('still accepts a token from the list used before per-token keys, once', () => {
    const legacy = 'a'.repeat(64)
    committed.set('_token', [legacy, 'b'.repeat(64)])
    const request = worker(committed)

    expect(new Token(request).check(legacy)).toBe(true)
    request.commit()
    expect(committed.get('_token')).toEqual(['b'.repeat(64)])
    expect(new Token(worker(committed)).check(legacy)).toBe(false)
  })
})
