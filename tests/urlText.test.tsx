import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { ExternalLink, UrlText } from '../src/renderer/src/components/UrlText'

describe('double-click URLs', () => {
  it('links plain user text without interpreting HTML or Markdown', () => {
    const html = renderToStaticMarkup(<UrlText text={'確認 https://example.com/page。 <script> **そのまま**'} />)
    expect(html).toContain('href="https://example.com/page"')
    expect(html).toContain('&lt;script&gt;')
    expect(html).toContain('**そのまま**')
    expect(html).not.toContain('<strong>')
  })
  it('opens once on double-click, suppressing mouse clicks while retaining keyboard activation', () => {
    const open = vi.fn()
    vi.stubGlobal('window', { open })
    try {
      const link = ExternalLink({ href: 'https://example.com' })
      const preventDefault = vi.fn()
      link.props.onClick({ detail: 1, preventDefault })
      link.props.onClick({ detail: 2, preventDefault })
      expect(preventDefault).toHaveBeenCalledTimes(2)
      expect(open).not.toHaveBeenCalled()
      link.props.onDoubleClick({ preventDefault })
      expect(open).toHaveBeenCalledExactlyOnceWith('https://example.com/', '_blank', 'noopener,noreferrer')
      preventDefault.mockClear()
      link.props.onClick({ detail: 0, preventDefault })
      expect(preventDefault).not.toHaveBeenCalled()
      ExternalLink({ href: 'javascript:alert(1)' }).props.onDoubleClick({ preventDefault })
      expect(open).toHaveBeenCalledTimes(1)
    } finally { vi.unstubAllGlobals() }
  })
})
