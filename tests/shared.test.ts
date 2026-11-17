import { describe, expect, it } from 'vitest'
import { applyEvent } from '../src/shared/state'
import type { ChatMessage, ChatState } from '../src/shared/types'
import {
  isConversationId,
  parseAgentId,
  parseConversationId,
  parseEffort,
  parseLeadingMention,
  parseSendRequest,
  parseTitle,
  titleFromMessage,
} from '../src/shared/validate'

const empty: ChatState = {
  title: 'テスト',
  messages: [],
  agents: {
    claude: { id: 'claude', model: null, effort: null, busy: false, activity: null },
    gpt: { id: 'gpt', model: null, effort: null, busy: false, activity: null },
  },
  dialogue: null,
}

const reply: ChatMessage = { id: 1, from: 'claude', to: 'user', text: '', at: '2026-11-16T05:00:00.000Z', status: 'streaming' }

describe('applyEvent', () => {
  it('adds, appends to and replaces messages', () => {
    let state = applyEvent(empty, { type: 'message:add', message: reply })
    state = applyEvent(state, { type: 'message:append', id: 1, text: 'こん' })
    state = applyEvent(state, { type: 'message:append', id: 1, text: 'にちは' })
    expect(state.messages[0]!.text).toBe('こんにちは')
    state = applyEvent(state, { type: 'message:update', message: { ...reply, text: 'こんにちは！', status: 'done' } })
    expect(state.messages[0]).toMatchObject({ text: 'こんにちは！', status: 'done' })
    expect(empty.messages).toEqual([]) // the input is not mutated
  })

  it('ignores a message added twice', () => {
    const once = applyEvent(empty, { type: 'message:add', message: reply })
    expect(applyEvent(once, { type: 'message:add', message: reply })).toBe(once)
  })

  it('updates an agent', () => {
    const busy = { id: 'gpt', model: 'gpt-6-sol', effort: 'low', busy: true, activity: { kind: 'thinking' } } as const
    const state = applyEvent(empty, { type: 'agent:update', agent: busy })
    expect(state.agents.gpt).toEqual(busy)
    expect(state.agents.claude).toBe(empty.agents.claude)
  })

  it('changes what an agent is doing, keeping the rest', () => {
    const busy = applyEvent(empty, { type: 'agent:update', agent: { id: 'gpt', model: 'gpt-6-sol', effort: null, busy: true, activity: { kind: 'thinking' } } })
    const searching = applyEvent(busy, { type: 'agent:activity', id: 'gpt', activity: { kind: 'searching', detail: '東京 雨' } })
    expect(searching.agents.gpt).toEqual({ id: 'gpt', model: 'gpt-6-sol', effort: null, busy: true, activity: { kind: 'searching', detail: '東京 雨' } })
    expect(searching.agents.claude).toBe(empty.agents.claude)
  })

  it('turns dialogue mode on and off', () => {
    const on = applyEvent(empty, { type: 'dialogue:update', dialogue: { next: 'gpt', turns: 3 } })
    expect(on.dialogue).toEqual({ next: 'gpt', turns: 3 })
    expect(applyEvent(on, { type: 'dialogue:update', dialogue: null }).dialogue).toBeNull()
  })

  it('renames the conversation', () => {
    expect(applyEvent(empty, { type: 'title:update', title: 'DB 選び' }).title).toBe('DB 選び')
  })
})

describe('parseEffort / parseAgentId', () => {
  it('accepts plain effort names and null', () => {
    expect(parseEffort('xhigh')).toBe('xhigh')
    expect(parseEffort(null)).toBeNull()
  })

  it.each(['', 'High', '--model', 'low; rm', 'x'.repeat(25), 3, undefined])('rejects the effort %j', (raw) => {
    expect(() => parseEffort(raw)).toThrow()
  })

  it('accepts only known agents', () => {
    expect(parseAgentId('gpt')).toBe('gpt')
    expect(() => parseAgentId('user')).toThrow()
  })
})

describe('parseSendRequest', () => {
  it('accepts a valid request', () => {
    expect(parseSendRequest({ text: 'hi', to: 'gpt' })).toEqual({ text: 'hi', to: 'gpt' })
  })

  it.each([null, 'hi', { text: 1, to: 'all' }, { text: 'hi', to: 'everyone' }, { text: 'x'.repeat(100_001), to: 'all' }])(
    'rejects %j',
    (raw) => {
      expect(() => parseSendRequest(raw)).toThrow()
    },
  )
})

describe('parseLeadingMention', () => {
  it.each([
    ['@Claude どう思う？', 'claude', 'どう思う？'],
    ['@gpt hi', 'gpt', 'hi'],
    ['  @全員 集合', 'all', '集合'],
    ['@GPT', 'gpt', ''],
  ] as const)('reads %j', (input, to, text) => {
    expect(parseLeadingMention(input)).toEqual({ to, text })
  })

  it('ignores mentions that are not at the start or not a participant', () => {
    expect(parseLeadingMention('ねえ @Claude')).toBeNull()
    expect(parseLeadingMention('@Claudette hi')).toBeNull()
    expect(parseLeadingMention('@someone hi')).toBeNull()
  })
})

describe('conversation IDs', () => {
  it('accepts IDs that are safe as file names', () => {
    expect(isConversationId('mi3k2x9a-1f2e3d')).toBe(true)
    expect(parseConversationId('abc')).toBe('abc')
  })

  it.each(['', '../secret', 'a/b', 'ABC', '-abc', 'a'.repeat(65), 1, null])('rejects %j', (raw) => {
    expect(isConversationId(raw)).toBe(false)
    expect(() => parseConversationId(raw)).toThrow()
  })
})

describe('parseTitle', () => {
  it('keeps one trimmed line', () => {
    expect(parseTitle('  DB の\n 相談  ')).toBe('DB の 相談')
  })

  it('cuts very long titles', () => {
    expect(parseTitle('あ'.repeat(500))).toHaveLength(120)
  })

  it.each(['', '   ', 3, null])('rejects %j', (raw) => {
    expect(() => parseTitle(raw)).toThrow()
  })
})

describe('titleFromMessage', () => {
  it('uses the first non-empty line', () => {
    expect(titleFromMessage('\n  DB は何がいい？\n詳しくは…')).toBe('DB は何がいい？')
  })

  it('cuts long lines by characters, not bytes', () => {
    expect(titleFromMessage('あ'.repeat(50), 10)).toBe('ああああああああああ…')
    expect(titleFromMessage('😀'.repeat(12), 10)).toBe('😀'.repeat(10) + '…')
  })

  it('returns an empty string for blank text', () => {
    expect(titleFromMessage(' \n ')).toBe('')
  })
})
