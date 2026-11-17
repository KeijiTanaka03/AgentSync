import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { MessageItem } from '../src/renderer/src/components/MessageItem'
import type { AgentActivity, ChatMessage } from '../src/shared/types'

const reply: ChatMessage = { id: 2, from: 'gpt', to: 'user', text: '', at: '2026-11-17T02:00:00.000Z', status: 'streaming' }
const html = (message: ChatMessage, activity: AgentActivity | null) =>
  renderToStaticMarkup(<MessageItem message={message} activity={activity} />)

describe('MessageItem', () => {
  it('says what a replying agent is doing, with the time so far', () => {
    const markup = html(reply, { kind: 'searching', detail: '東京 雨の日' })
    expect(markup).toContain('ウェブを検索中…')
    expect(markup).toContain('「東京 雨の日」')
    expect(markup).toMatch(/\d+ 秒/)
  })

  it('starts as thinking before the agent has said anything', () => {
    expect(html(reply, null)).toContain('考え中…')
  })

  it('shows only the caret while the text is coming in', () => {
    const markup = html({ ...reply, text: '美術館はどう？' }, { kind: 'writing' })
    expect(markup).toContain('class="caret"')
    expect(markup).not.toContain('class="activity')
  })

  it('shows thinking again under text already written', () => {
    const markup = html({ ...reply, text: '調べてみます。' }, { kind: 'thinking' })
    expect(markup).toContain('調べてみます。')
    expect(markup).toContain('考え中…')
    expect(markup).not.toContain('class="caret"')
  })

  it('shows nothing extra once the reply is done', () => {
    const markup = html({ ...reply, text: '美術館はどう？', status: 'done' }, null)
    expect(markup).not.toContain('class="activity')
    expect(markup).not.toContain('class="caret"')
  })
})
