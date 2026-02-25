const Form = require('../../src/View/Form')

describe('Form HTML escaping', () => {
  test('should escape textarea content to prevent tag breakout XSS', () => {
    const html = Form.generateFieldHtml({
      name: 'bio',
      type: 'textarea',
      placeholder: 'About me',
      label: null,
      class: '',
      id: null,
      value: '</textarea><script>alert(1)</script>',
      validations: [],
      extraAttributes: {}
    })

    expect(html).toContain('&lt;/textarea&gt;&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(html).not.toContain('</textarea><script>alert(1)</script>')
  })

  test('should escape full HTML entities in input value attributes', () => {
    const html = Form.generateFieldHtml({
      name: 'displayName',
      type: 'text',
      placeholder: 'Name',
      label: null,
      class: '',
      id: null,
      value: 'a&b"c<d>e\'f',
      validations: [],
      extraAttributes: {}
    })

    expect(html).toContain('value="a&amp;b&quot;c&lt;d&gt;e&#39;f"')
    expect(html).not.toContain('value="a&b"c<d>e\'f"')
  })
})
