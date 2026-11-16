import { describe, expect, it } from 'vitest'
import { chatSystemPrompt, collectUnseen, formatUnseen, replyTarget } from '../src/main/chat/prompt'
import type { ChatMessage } from '../src/shared/types'

let id = 0
function message(fields: Partial<ChatMessage> & Pick<ChatMessage, 'from' | 'to' | 'text'>): ChatMessage {
  id += 1
  return { id, at: '2026-11-16T05:00:00.000Z', status: 'done', ...fields }
}

describe('collectUnseen', () => {
  it('skips own messages, delivered ones, streaming ones and empty ones', () => {
    const a = message({ from: 'user', to: 'all', text: 'こんにちは' })
    const b = message({ from: 'claude', to: 'user', text: 'Claude です' })
    const c = message({ from: 'gpt', to: 'user', text: 'GPT です' })
    const d = message({ from: 'gpt', to: 'user', text: '途中', status: 'streaming' })
    const e = message({ from: 'gpt', to: 'user', text: '  ', status: 'stopped' })
    const f = message({ from: 'user', to: 'claude', text: '続けて' })

    const unseen = collectUnseen([a, b, c, d, e, f], 'claude', new Set([a.id]))
    expect(unseen.map((m) => m.id)).toEqual([c.id, f.id])
  })

  it('delivers a message that was streaming last time once it has finished', () => {
    const streaming = message({ from: 'gpt', to: 'user', text: '考え中', status: 'streaming' })
    expect(collectUnseen([streaming], 'claude', new Set())).toEqual([])
    const finished = { ...streaming, status: 'done' as const }
    expect(collectUnseen([finished], 'claude', new Set())).toEqual([finished])
  })
})

describe('formatUnseen', () => {
  it('labels every message with sender and recipient from the agent’s point of view', () => {
    const text = formatUnseen(
      [
        message({ from: 'user', to: 'all', text: 'DB は何がいい？' }),
        message({ from: 'gpt', to: 'user', text: 'Postgres です' }),
        message({ from: 'user', to: 'claude', text: 'Claude はどう思う？' }),
        message({ from: 'gpt', to: 'claude', text: '反論ある？', status: 'stopped' }),
      ],
      'claude',
    )
    expect(text).toBe(
      [
        '【ユーザー → 全員】\nDB は何がいい？',
        '【GPT → ユーザー】\nPostgres です',
        '【ユーザー → あなた】\nClaude はどう思う？',
        '【GPT → あなた】\n反論ある？\n（この発言は途中で止められました）',
      ].join('\n\n'),
    )
  })
})

describe('replyTarget', () => {
  it('answers whoever last addressed the agent or everyone', () => {
    const toAll = message({ from: 'user', to: 'all', text: 'a' })
    const gptToUser = message({ from: 'gpt', to: 'user', text: 'b' })
    expect(replyTarget([toAll, gptToUser], 'claude')).toBe('user')
    const gptToClaude = message({ from: 'gpt', to: 'claude', text: 'c' })
    expect(replyTarget([toAll, gptToClaude], 'claude')).toBe('gpt')
  })
})

describe('chatSystemPrompt', () => {
  it('names the agent and the other participant', () => {
    expect(chatSystemPrompt('claude')).toContain('あなたは「Claude」')
    expect(chatSystemPrompt('claude')).toContain('GPT は、同じチャットにいる別の AI')
    expect(chatSystemPrompt('gpt')).toContain('あなたは「GPT」')
  })
})
