const Var = require('../../src/Var')

// hashAsync()/hashCheckAsync() run scrypt on the thread pool for request paths and must stay
// interchangeable with the synchronous forms; malformed hashes fail instead of throwing.

describe('Var hashing', () => {
  it('produces hashes the synchronous check accepts, and vice versa', async () => {
    const asyncHash = await new Var('s3cret').hashAsync()
    expect(asyncHash).toMatch(/^\$scrypt\$[0-9a-f]{32}\$[0-9a-f]{128}$/)
    expect(new Var(asyncHash).hashCheck('s3cret')).toBe(true)
    await expect(new Var(new Var('s3cret').hash()).hashCheckAsync('s3cret')).resolves.toBe(true)
  })

  it('rejects a wrong candidate', async () => {
    const hash = await new Var('s3cret').hashAsync()
    await expect(new Var(hash).hashCheckAsync('wrong')).resolves.toBe(false)
  })

  it.each(['$scrypt$aa$abcd', '$scrypt$aa$zz', '$scrypt$aa', 'plain', null])('fails a malformed hash %p without throwing', async stored => {
    expect(new Var(stored).hashCheck('x')).toBe(false)
    await expect(new Var(stored).hashCheckAsync('x')).resolves.toBe(false)
  })
})
