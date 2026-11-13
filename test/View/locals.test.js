const fsSync = require('fs')
const path = require('path')
const {project} = require('./project')

// `Odac.set()` values are template locals: `{{ username }}` and `<odac var="user.name">` read
// them by name, as documented. Before, views threw `ReferenceError: username is not defined`.
describe('View locals from Odac.set()', () => {
  const app = project()
  beforeEach(app.setup)
  afterEach(app.teardown)

  const cacheFiles = () => fsSync.readdirSync(path.join(app.dir, 'storage/.cache')).filter(name => !name.endsWith('.tmp'))

  it('reads set values by name in {{ }} and <odac var>', async () => {
    await app.write('view/content/profile.html', '<h1>{{ username }}</h1><p><odac var="user.email" /></p>')
    const html = await app.render('profile', {variables: {username: 'Ada <3', user: {email: 'ada@example.com'}}})
    expect(html).toBe('<h1>Ada &lt;3</h1><p>ada@example.com</p>')
  })

  it('reads set values in conditions and loops', async () => {
    await app.write(
      'view/content/list.html',
      '<odac:if condition="error">E</odac:if><odac:for in="items" value="item">[{{ item }}]</odac:for>'
    )
    expect(await app.render('list', {variables: {error: null, items: ['a', 'b']}})).toBe('[a][b]')
  })

  it('lets backend code declare a name that is also set', async () => {
    await app.write(
      'view/content/shadow.html',
      '<script:odac>const user = {name: "local"}; var title = "var"</script:odac>{{ user.name }} {{ title }}'
    )
    expect(await app.render('shadow', {variables: {user: {name: 'set'}, title: 'set'}})).toBe('local var')
  })

  it('does not declare keys that are not identifiers or are reserved', async () => {
    await app.write('view/content/odd.html', `<p>{{ get('first-name') }} {{ typeof html }}</p>`)
    const html = await app.render('odd', {variables: {'first-name': 'Ada', html: 'x', class: 'y', props: 'z'}})
    expect(html).toBe('<p>Ada string</p>')
  })

  it('compiles one module per set of mentioned keys, ignoring unrelated keys', async () => {
    await app.write('view/content/keys.html', '<p>{{ typeof a }} {{ typeof b }}</p>')
    expect(await app.render('keys', {variables: {a: 1}})).toBe('<p>number undefined</p>')
    expect(await app.render('keys', {variables: {a: 1, b: 'x'}})).toBe('<p>number string</p>')
    const files = cacheFiles().length

    // Keys the template never mentions (for example derived from user input) add no variant.
    for (let i = 0; i < 5; i++) await app.render('keys', {variables: {a: 1, b: 'x', [`input${i}`]: i}})
    expect(cacheFiles()).toHaveLength(files)
  })

  // Keys taken from input (`Odac.set(Odac.Request.data.post)`) that match words of the template
  // must not compile a module per combination: past 32 sets one scoped module serves the rest.
  it('stops compiling variants after 32 key sets and renders the rest from one scoped module', async () => {
    const words = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta']
    await app.write(
      'view/content/words.html',
      `<p>alpha beta gamma delta epsilon zeta eta</p>{{ typeof alpha }} {{ typeof eta }} {{ typeof html }}<script:odac>const beta = 'local'</script:odac> {{ beta }}`
    )
    const render = mask => {
      const variables = {html: 'hijack', props: 'hijack'}
      words.forEach((word, i) => {
        if (mask & (1 << i)) variables[word] = i
      })
      return app.render('words', {variables, debug: false})
    }
    const expected = mask =>
      `<p>alpha beta gamma delta epsilon zeta eta</p>${mask & 1 ? 'number' : 'undefined'} ${mask & 64 ? 'number' : 'undefined'} string local`

    for (let mask = 0; mask < 100; mask++) expect(await render(mask)).toBe(expected(mask))
    expect(cacheFiles()).toHaveLength(33)
    // A set that compiled its own module keeps using it.
    expect(await render(5)).toBe(expected(5))
    expect(cacheFiles()).toHaveLength(33)
  })

  it('reports a failure in the scoped module at its template line', async () => {
    await app.write('view/content/scoped.html', '<p>a0 a1 a2 a3 a4 a5</p>\n{{ a0 }}\n{{ missing.value }}')
    const render = mask => {
      const variables = {}
      for (let i = 0; i < 6; i++) if (mask & (1 << i)) variables[`a${i}`] = i
      return app.render('scoped', {variables, debug: false})
    }
    for (let mask = 0; mask < 32; mask++) await render(mask)
    app.errors.mockClear()

    // Key sets 32 and 33 are new: both render from the scoped module.
    expect(await render(32)).toBeUndefined()
    expect(app.logged()).toBe('ReferenceError: a0 is not defined\n  in line 2\n  of "./view/content/scoped.html"')
    app.errors.mockClear()
    expect(await render(33)).toBeUndefined()
    expect(app.logged()).toBe('ReferenceError: missing is not defined\n  in line 3\n  of "./view/content/scoped.html"')
  })

  it('renders set values from the production cache', async () => {
    await app.write('view/content/prod.html', '<p>{{ name }}</p>')
    expect(await app.render('prod', {variables: {name: 'one'}})).toBe('<p>one</p>')
    expect(await app.render('prod', {variables: {name: 'two'}, debug: false})).toBe('<p>two</p>')
  })
})
