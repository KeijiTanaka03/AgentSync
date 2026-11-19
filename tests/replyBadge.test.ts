import { describe, expect, it } from 'vitest'
import { ReplyBadge } from '../src/main/replyBadge'
import type { ChatMessage, ConversationEventEnvelope } from '../src/shared/types'

const reply: ChatMessage = { id: 2, from: 'gpt', to: 'user', text: '完了しました', at: '2026-11-17T00:00:00Z', status: 'done' }
const event = (conversationId = 'a', message = reply): ConversationEventEnvelope => ({ conversationId, seq: 1, event: { type: 'message:update', message } })

describe('reply completion Dock badge', () => {
  it('counts replies across agents and threads without counting a duplicate twice', () => {
    const labels: string[] = []
    const badge = new ReplyBadge((label) => labels.push(label))
    expect(badge.receive(event(), false)).toBe(true)
    expect(badge.receive(event(), false)).toBe(false)
    badge.receive(event('b'), false)
    badge.receive(event('a', { ...reply, id: 3, from: 'claude' }), false)
    expect(labels).toEqual(['1', '2', '3'])
    badge.clear()
    expect(labels.at(-1)).toBe('')
    badge.receive(event('c'), false)
    expect(labels.at(-1)).toBe('1')
  })

  it('does not notify for foreground replies, stopped replies, errors, or user/system messages', () => {
    const labels: string[] = []
    const badge = new ReplyBadge((label) => labels.push(label))
    badge.receive(event(), true)
    for (const status of ['streaming', 'stopped', 'error'] as const) badge.receive(event('a', { ...reply, status }), false)
    for (const from of ['user', 'system'] as const) badge.receive(event('a', { ...reply, from }), false)
    badge.receive({ conversationId: 'a', seq: 2, event: { type: 'message:append', id: 2, text: '途中' } }, false)
    expect(labels).toEqual([])
  })
})
