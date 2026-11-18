import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { UsageSummaryAgent } from '../src/renderer/src/components/UsageSummary'

describe('sidebar usage', () => {
  it('shows both zero usage and the weekly window with accessible meters', () => {
    const html = renderToStaticMarkup(<UsageSummaryAgent id="claude" report={{ error: null, windows: [
      { label: '5時間', usedPercent: 0, resets: null },
      { label: '週間', usedPercent: 92, resets: '明日' },
    ] }} />)
    expect(html).toContain('aria-label="Claude 5時間"')
    expect(html).toContain('aria-valuenow="0"')
    expect(html).toContain('aria-valuenow="92"')
    expect(html).toContain('usage-high')
    expect(html).toContain('リセット: 明日')
  })
  it('distinguishes unavailable data from zero and marks stale values', () => {
    const html = renderToStaticMarkup(<UsageSummaryAgent id="gpt" report={{ error: 'ログインが必要', windows: [] }} />)
    expect(html).toContain('取得できません')
    expect(html).toContain('ログインが必要')
    expect(html).not.toContain('0%')
    const stale = renderToStaticMarkup(<UsageSummaryAgent id="gpt" stale report={{ error: null, windows: [{ label: '5時間', usedPercent: 34, resets: null }] }} />)
    expect(stale).toContain('34% *')
  })
})
