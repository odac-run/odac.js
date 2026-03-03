const EarlyHints = require('../../../src/View/EarlyHints')

describe('EarlyHints.send()', () => {
  let earlyHints
  let mockConfig

  beforeEach(() => {
    mockConfig = {
      enabled: true,
      auto: true,
      maxResources: 5
    }
    earlyHints = new EarlyHints(mockConfig)
  })

  it('should return false when disabled', () => {
    const hints = new EarlyHints({enabled: false})
    const mockRes = {
      headersSent: false,
      writableEnded: false,
      writeEarlyHints: jest.fn()
    }
    const resources = [{href: '/css/main.css', as: 'style'}]

    const result = hints.send(mockRes, resources)
    expect(result).toBe(false)
    expect(mockRes.writeEarlyHints).not.toHaveBeenCalled()
  })

  it('should return false when headers already sent', () => {
    const mockRes = {
      headersSent: true,
      writableEnded: false,
      writeEarlyHints: jest.fn()
    }
    const resources = [{href: '/css/main.css', as: 'style'}]

    const result = earlyHints.send(mockRes, resources)
    expect(result).toBe(false)
    expect(mockRes.writeEarlyHints).not.toHaveBeenCalled()
  })

  it('should return false when response ended', () => {
    const mockRes = {
      headersSent: false,
      writableEnded: true,
      writeEarlyHints: jest.fn()
    }
    const resources = [{href: '/css/main.css', as: 'style'}]

    const result = earlyHints.send(mockRes, resources)
    expect(result).toBe(false)
    expect(mockRes.writeEarlyHints).not.toHaveBeenCalled()
  })

  it('should return true even when writeEarlyHints not available', () => {
    const mockRes = {
      headersSent: false,
      writableEnded: false,
      setHeader: jest.fn()
    }
    const resources = [{href: '/css/main.css', as: 'style'}]

    const result = earlyHints.send(mockRes, resources)
    expect(result).toBe(true)
    expect(mockRes.setHeader).toHaveBeenCalledWith('X-Odac-Early-Hints', JSON.stringify(['</css/main.css>; rel=preload; as=style']))
  })

  it('should send early hints successfully', () => {
    const mockRes = {
      headersSent: false,
      writableEnded: false,
      writeEarlyHints: jest.fn(),
      setHeader: jest.fn()
    }
    const resources = [{href: '/css/main.css', as: 'style'}]

    const result = earlyHints.send(mockRes, resources)
    expect(result).toBe(true)
    expect(mockRes.writeEarlyHints).toHaveBeenCalledWith({
      link: ['</css/main.css>; rel=preload; as=style']
    })
    expect(mockRes.setHeader).toHaveBeenCalledWith('X-Odac-Early-Hints', JSON.stringify(['</css/main.css>; rel=preload; as=style']))
  })

  it('should handle writeEarlyHints errors gracefully', () => {
    const mockRes = {
      headersSent: false,
      writableEnded: false,
      writeEarlyHints: jest.fn(() => {
        throw new Error('Write error')
      })
    }
    const resources = [{href: '/css/main.css', as: 'style'}]

    const result = earlyHints.send(mockRes, resources)
    expect(result).toBe(false)
  })
})
