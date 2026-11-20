import { describe, expect, it } from 'vitest'
import { collectUnseen, GROUP_CHAT_PROMPT, formatUnseen, isApproved, replyTarget, turnNote } from '../src/main/chat/prompt'
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
        '【GPT → あなた】\n反論ある？',
      ].join('\n\n'),
    )
  })
})

describe('notices from AgentSync', () => {
  const start = message({ from: 'system', to: 'all', text: 'ここから対話モード · Claude から開始', notice: 'dialogue-start' })
  const stop = message({ from: 'system', to: 'all', text: '対話モードを止めました', notice: 'dialogue-stop' })

  it('are delivered to both agents, worded for each', () => {
    expect(collectUnseen([start], 'claude', new Set())).toEqual([start])
    expect(formatUnseen([start], 'claude')).toBe('【AgentSync】\nDialogue mode: you and GPT take turns until the user stops it.')
    expect(formatUnseen([start], 'gpt')).toContain('you and Claude take turns')
    expect(formatUnseen([stop], 'gpt')).toBe('【AgentSync】\nDialogue mode ended.')
  })

  it('are never what an agent replies to', () => {
    const toAll = message({ from: 'user', to: 'all', text: 'お題' })
    expect(replyTarget([toAll, start], 'claude')).toBe('user')
    expect(replyTarget([start], 'claude')).toBe('user')
  })

})

describe('実装＋レビュー notices', () => {
  const start = message({ from: 'system', to: 'all', text: 'ここから実装＋レビュー', notice: 'review-start', implementer: 'claude' })
  const diff = message({ from: 'system', to: 'all', text: '変更を渡しました', notice: 'review-diff', implementer: 'claude', detail: '-a\n+b' })

  it('give each agent its role', () => {
    expect(formatUnseen([start], 'claude')).toContain("implement the user's last request. GPT reviews")
    expect(formatUnseen([start], 'gpt')).toContain('Claude implements, you review')
    expect(formatUnseen([diff], 'gpt')).toContain('reply with APPROVED on the first line')
  })

  it('hand the diff to the reviewer only', () => {
    expect(formatUnseen([diff], 'gpt')).toContain('```diff\n-a\n+b\n```')
    expect(formatUnseen([diff], 'claude')).toBe('【AgentSync】\nYour git diff was sent to GPT for review.')
  })

  it('recognise APPROVED on the first line only', () => {
    expect(isApproved('APPROVED')).toBe(true)
    expect(isApproved('\n**APPROVED**\nテストも通っています。')).toBe(true)
    expect(isApproved('指摘があります。\nAPPROVED ではありません')).toBe(false)
    expect(isApproved('NOT APPROVED')).toBe(false)
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

describe('GROUP_CHAT_PROMPT', () => {
  it('asks to answer only messages addressed to the agent, without headings', () => {
    expect(GROUP_CHAT_PROMPT).toContain('Reply only to those addressed to あなた or 全員')
    expect(GROUP_CHAT_PROMPT).toContain('do not head your reply')
  })
})

describe('turnNote', () => {
  it('lets a read-only turn read files with commands, but not change them', () => {
    expect(turnNote('read', 'ask')).toBe('【AgentSync】\nThis turn is read-only: read and search, change nothing.')
  })
})

