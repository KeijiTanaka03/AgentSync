import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { MarkdownText } from '../src/renderer/src/components/MarkdownText'

const html = (text: string) => renderToStaticMarkup(<MarkdownText text={text} />)

describe('MarkdownText', () => {
  it('makes text bold next to Japanese punctuation', () => {
    expect(html('築地の**「大江戸 寿司 朝食」**のような市場')).toContain('<strong>「大江戸 寿司 朝食」</strong>')
  })

  it('renders tables and code from GFM', () => {
    expect(html('| a | b |\n|---|---|\n| 1 | 2 |')).toContain('<table>')
    expect(html('```ts\nconst a = 1\n```')).toContain('<code class="language-ts">')
  })

  it('does not render raw HTML from a reply', () => {
    const out = html('<img src=x onerror="alert(1)"> と <script>alert(1)</script>')
    expect(out).not.toContain('<img')
    expect(out).not.toContain('<script')
  })

  it('opens links outside the app', () => {
    expect(html('[公式](https://example.com)')).toContain('target="_blank" rel="noreferrer"')
  })
})
