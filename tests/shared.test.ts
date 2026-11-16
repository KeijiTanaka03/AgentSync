import { describe, expect, it } from 'vitest'
import { applyEvent } from '../src/shared/state'
import type { ChatMessage, ChatState } from '../src/shared/types'
import { parseLeadingMention, parseSendRequest } from '../src/shared/validate'

const empty: ChatState = {
  title: 'テスト',
  messages: [],
  agents: {
    claude: { id: 'claude', model: null, busy: false },
    gpt: { id: 'gpt', model: null, busy: false },
  },
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
    const state = applyEvent(empty, { type: 'agent:update', agent: { id: 'gpt', model: 'gpt-6-sol', busy: true } })
    expect(state.agents.gpt).toEqual({ id: 'gpt', model: 'gpt-6-sol', busy: true })
    expect(state.agents.claude).toBe(empty.agents.claude)
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
