const Validator = require('../../src/Validator')
const Var = require('../../src/Var')

// Rule evaluation for POST values. JSON bodies deliver numbers, booleans, arrays and objects,
// not just strings, so rules must neither skip falsy scalars nor accept coerced containers.

function validate(post, build) {
  const request = {request: async key => post[key]}
  const validator = new Validator(request, {Var: (...args) => new Var(...args)})
  build(validator)
  return validator.result()
}

const errorsOf = async (post, build) => (await validate(post, build)).errors ?? {}

describe('Validator rule evaluation', () => {
  it('applies min and max to 0 and false instead of skipping them', async () => {
    expect(await errorsOf({qty: 0}, v => v.post('qty').check('min:1').message('too small'))).toEqual({qty: 'too small'})
    expect(await errorsOf({qty: false}, v => v.post('qty').check('min:1').message('too small'))).toEqual({qty: 'too small'})
    expect(await errorsOf({qty: 0}, v => v.post('qty').check('max:-1').message('too big'))).toEqual({qty: 'too big'})
  })

  it('rejects a non-numeric value for min/max', async () => {
    expect(await errorsOf({qty: 'abc'}, v => v.post('qty').check('min:1').message('bad'))).toEqual({qty: 'bad'})
  })

  it('accepts numbers from a JSON body', async () => {
    const errors = await errorsOf({qty: 3, code: 5}, v => {
      v.post('qty').check('numeric|min:1|max:5').message('bad qty')
      v.post('code').check('equal:5').message('bad code')
    })
    expect(errors).toEqual({})
  })

  it.each([
    ['email', ['a@b.co']],
    ['email', {toString: () => 'a@b.co'}],
    ['numeric', [1]],
    ['maxlen:10', ['a']],
    ['regex:^a', ['a']],
    ['url', ['https://example.com']]
  ])('rejects an array or object for %s', async (rule, value) => {
    expect(await errorsOf({field: value}, v => v.post('field').check(rule).message('bad'))).toEqual({field: 'bad'})
  })

  it('still lets the array rule accept arrays', async () => {
    expect(await errorsOf({tags: ['a']}, v => v.post('tags').check('required|array').message('bad'))).toEqual({})
    expect(await errorsOf({tags: 'a'}, v => v.post('tags').check('array').message('bad'))).toEqual({tags: 'bad'})
  })

  it('skips format rules for absent and empty values', async () => {
    const errors = await errorsOf({a: '', b: null}, v => {
      v.post('a').check('email|min:3').message('a')
      v.post('b').check('url').message('b')
      v.post('c').check('numeric').message('c')
    })
    expect(errors).toEqual({})
  })

  it('validates a boolean against format rules instead of skipping it', async () => {
    expect(await errorsOf({mail: false}, v => v.post('mail').check('email').message('bad'))).toEqual({mail: 'bad'})
  })
})
