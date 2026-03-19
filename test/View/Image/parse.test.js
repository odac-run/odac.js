const Image = require('../../../src/View/Image')

describe('Image.parse()', () => {
  test('should convert <odac:img> with static src to <script:odac> block', () => {
    const input = '<odac:img src="/images/hero.jpg" width="200" />'
    const result = Image.parse(input)

    expect(result).toContain('<script:odac>')
    expect(result).toContain('Odac.View.Image.render(')
    expect(result).toContain('"src":"/images/hero.jpg"')
    expect(result).toContain('"width":"200"')
    expect(result).toContain('</script:odac>')
  })

  test('should convert {{ }} expressions to live JS with Odac.Var', () => {
    const input = '<odac:img src="{{ post.cover }}" alt="{{ post.title }}" />'
    const result = Image.parse(input)

    expect(result).toContain('(await Odac.Var(await  post.cover ).html())')
    expect(result).toContain('(await Odac.Var(await  post.title ).html())')
    expect(result).not.toContain('{{')
    expect(result).not.toContain('}}')
  })

  test('should convert {!! !!} expressions to raw JS', () => {
    const input = '<odac:img src="{!! getImageUrl() !!}" />'
    const result = Image.parse(input)

    expect(result).toContain('(await  getImageUrl() )')
    expect(result).not.toContain('{!!')
    expect(result).not.toContain('!!}')
  })

  test('should leave tag unchanged when src is missing', () => {
    const input = '<odac:img alt="no source" />'
    const result = Image.parse(input)

    expect(result).toBe(input)
  })

  test('should not affect non-img odac tags', () => {
    const input = '<odac var="title" /> <odac:img src="/a.jpg" />'
    const result = Image.parse(input)

    expect(result).toContain('<odac var="title" />')
    expect(result).toContain('<script:odac>')
  })

  test('should handle self-closing tag without trailing slash', () => {
    const input = '<odac:img src="/a.jpg">'
    const result = Image.parse(input)

    // Both <odac:img ... /> and <odac:img ...> are valid — parser handles both
    expect(result).toContain('<script:odac>')
    expect(result).toContain('"/a.jpg"')
  })

  test('should handle multiple img tags in one template', () => {
    const input = ['<odac:img src="/a.jpg" width="100" />', '<p>text</p>', '<odac:img src="/b.png" format="avif" />'].join('\n')
    const result = Image.parse(input)

    const scriptCount = (result.match(/<script:odac>/g) || []).length
    expect(scriptCount).toBe(2)
    expect(result).toContain('"/a.jpg"')
    expect(result).toContain('"/b.png"')
  })

  test('should preserve boolean attributes', () => {
    const input = '<odac:img src="/a.jpg" loading />'
    const result = Image.parse(input)

    expect(result).toContain('"loading":true')
  })

  test('should handle mixed static and dynamic attributes', () => {
    const input = '<odac:img src="{{ item.image }}" class="rounded" width="300" />'
    const result = Image.parse(input)

    expect(result).toContain('(await Odac.Var(await  item.image ).html())')
    expect(result).toContain('"class":"rounded"')
    expect(result).toContain('"width":"300"')
  })
})
