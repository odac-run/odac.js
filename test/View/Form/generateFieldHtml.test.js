const Form = require('../../../src/View/Form')

describe('Form.generateFieldHtml()', () => {
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

  test('should render a file input without value/placeholder attributes', () => {
    const html = Form.generateFieldHtml({
      name: 'avatar',
      type: 'file',
      placeholder: 'ignored',
      label: null,
      class: '',
      id: null,
      value: null,
      validations: [],
      extraAttributes: {}
    })

    expect(html).toContain('type="file"')
    expect(html).toContain('name="avatar"')
    expect(html).not.toContain('value=')
    expect(html).not.toContain('placeholder=')
  })

  test('should map file validation rules to accept/multiple/data-* attributes', () => {
    const html = Form.generateFieldHtml({
      name: 'photos',
      type: 'file',
      placeholder: '',
      label: null,
      class: '',
      id: null,
      value: null,
      validations: [{rule: 'required|maxsize:2MB|mimetype:image/png,image/jpeg|maxfiles:3', message: 'Bad file'}],
      extraAttributes: {}
    })

    expect(html).toContain('required')
    expect(html).toContain('accept="image/png,image/jpeg"')
    expect(html).toContain(`data-maxsize="${2 * 1024 * 1024}"`)
    expect(html).toContain('multiple')
    expect(html).toContain('data-maxfiles="3"')
    expect(html).toContain('data-error-maxsize="Bad file"')
  })

  test('should convert ext rule to a dot-prefixed accept list', () => {
    const html = Form.generateFieldHtml({
      name: 'doc',
      type: 'file',
      placeholder: '',
      label: null,
      class: '',
      id: null,
      value: null,
      validations: [{rule: 'ext:pdf,docx', message: null}],
      extraAttributes: {}
    })

    expect(html).toContain('accept=".pdf,.docx"')
  })
})
