import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConversationStore, parseConversation, type ConversationData } from '../src/main/store/conversationStore'

function conversation(id: string, updatedAt: string, overrides: Partial<ConversationData> = {}): ConversationData {
  return {
    version: 1,
    id,
    title: `会話 ${id}`,
    kind: 'chat',
    workdir: null,
    approvalMode: 'ask',
    roles: 'single',
    createdAt: '2026-11-16T05:00:00.000Z',
    updatedAt,
    participants: {
      claude: { model: 'claude-opus-5-5', effort: 'high', sessionId: 'claude-1', delivered: [1] },
      gpt: { model: null, effort: null, sessionId: null, delivered: [] },
    },
    messages: [
      { id: 1, from: 'user', to: 'all', text: 'DB は何がいい？', at: '2026-11-16T05:00:00.000Z', status: 'done' },
      { id: 2, from: 'claude', to: 'user', text: 'SQLite', at: '2026-11-16T05:00:01.000Z', status: 'done' },
    ],
    ...overrides,
  }
}

describe('ConversationStore', () => {
  let directory: string
  let store: ConversationStore

  beforeEach(() => {
    directory = path.join(mkdtempSync(path.join(tmpdir(), 'agentsync-store-')), 'conversations')
    store = new ConversationStore(directory)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('saves and loads a conversation', () => {
    const data = conversation('a1', '2026-11-16T05:00:01.000Z')
    store.save(data)
    expect(store.load('a1')).toEqual({ ...data, pinned: false })
    expect(readdirSync(directory)).toEqual(['a1.json']) // no temp file left behind
  })

  it('keeps the files private to the user', () => {
    store.save(conversation('a1', '2026-11-16T05:00:01.000Z'))
    expect(statSync(path.join(directory, 'a1.json')).mode & 0o777).toBe(0o600)
    expect(statSync(directory).mode & 0o777).toBe(0o700)
  })

  it('lists conversations newest first and skips files it cannot read', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    store.save(conversation('old', '2026-11-15T05:00:00.000Z'))
    store.save(conversation('new', '2026-11-16T05:00:00.000Z'))
    writeFileSync(path.join(directory, 'broken.json'), '{ not json')
    writeFileSync(path.join(directory, 'future.json'), JSON.stringify({ version: 2 }))
    writeFileSync(path.join(directory, 'notes.txt'), 'hello')
    expect(store.list().map((c) => c.id)).toEqual(['new', 'old'])
    // Unreadable files are left as they are.
    expect(readFileSync(path.join(directory, 'broken.json'), 'utf8')).toBe('{ not json')
  })

  it('removes a conversation', () => {
    store.save(conversation('a1', '2026-11-16T05:00:01.000Z'))
    store.remove('a1')
    store.remove('a1') // already gone: no error
    expect(existsSync(path.join(directory, 'a1.json'))).toBe(false)
  })

  it('refuses IDs that could leave the folder', () => {
    expect(() => store.load('../secret')).toThrow('会話の ID が不正です')
    expect(() => store.save(conversation('../x', '2026-11-16T05:00:00.000Z'))).toThrow('会話の ID が不正です')
  })
})

describe('parseConversation', () => {
  it('turns a reply left streaming into a stopped one and drops broken messages', () => {
    const raw = {
      ...conversation('a1', '2026-11-16T05:00:01.000Z'),
      messages: [
        { id: 1, from: 'user', to: 'all', text: 'hi', at: '2026-11-16T05:00:00.000Z', status: 'done' },
        { id: 2, from: 'claude', to: 'user', text: '途中', at: '2026-11-16T05:00:01.000Z', status: 'streaming' },
        { id: 3, from: 'someone', to: 'user', text: '?', at: '2026-11-16T05:00:02.000Z', status: 'done' },
        { id: 'x', from: 'gpt', to: 'user', text: '?', at: '2026-11-16T05:00:02.000Z', status: 'done' },
      ],
    }
    const parsed = parseConversation(raw, 'a1')
    expect(parsed.messages.map((m) => [m.id, m.status])).toEqual([
      [1, 'done'],
      [2, 'stopped'],
    ])
  })

  it('fills in what is missing', () => {
    const parsed = parseConversation({ version: 1, messages: [] }, 'a1')
    expect(parsed).toMatchObject({
      id: 'a1',
      title: '新しい会話',
      participants: {
        claude: { model: null, effort: null, sessionId: null, delivered: [] },
        gpt: { model: null, effort: null, sessionId: null, delivered: [] },
      },
    })
  })

  it('keeps notices from AgentSync and drops system messages that are not one', () => {
    const at = '2026-11-17T05:00:00.000Z'
    const parsed = parseConversation(
      {
        version: 1,
        messages: [
          { id: 1, from: 'system', to: 'all', text: 'ここから対話モード · Claude から開始', at, status: 'done', notice: 'dialogue-start' },
          { id: 6, from: 'system', to: 'all', text: '変更を渡しました', at, status: 'done', notice: 'review-diff', implementer: 'gpt', detail: '+x' },
          { id: 2, from: 'system', to: 'all', text: '?', at, status: 'done' },
          { id: 3, from: 'system', to: 'all', text: '?', at, status: 'done', notice: 'launch' },
          { id: 4, from: 'claude', to: 'gpt', text: '反論します', at, status: 'done' },
          { id: 5, from: 'claude', to: 'system', text: '?', at, status: 'done' },
        ],
      },
      'a1',
    )
    expect(parsed.messages.map((m) => [m.id, m.from, m.notice])).toEqual([
      [1, 'system', 'dialogue-start'],
      [6, 'system', 'review-diff'],
      [4, 'claude', undefined],
    ])
    expect(parsed.messages[1]).toMatchObject({ implementer: 'gpt', detail: '+x' })
  })

  it('keeps a coding conversation: its folder, approval mode, work logs and approvals', () => {
    const at = '2026-11-17T05:00:00.000Z'
    const parsed = parseConversation(
      {
        version: 1,
        kind: 'code',
        workdir: '/work/app',
        approvalMode: 'auto',
        messages: [
          {
            id: 1,
            from: 'claude',
            to: 'user',
            text: '直しました',
            at,
            status: 'done',
            tools: [
              { id: 't1', kind: 'command', title: 'npm test', status: 'running' },
              { id: 't2', kind: 'nope', title: '?', status: 'done' },
            ],
            approvals: [{ id: '1-1', kind: 'command', title: 'コマンドを実行: npm test', detail: 'npm test', status: 'pending' }],
          },
        ],
      },
      'a1',
    )
    expect(parsed).toMatchObject({ kind: 'code', workdir: '/work/app', approvalMode: 'auto' })
    expect(parsed.messages[0]!.tools).toEqual([{ id: 't1', kind: 'command', title: 'npm test', status: 'failed' }])
    expect(parsed.messages[0]!.approvals![0]!.status).toBe('denied')
    // A folder that is not an absolute path makes it a plain chat.
    expect(parseConversation({ version: 1, kind: 'code', workdir: 'relative/app' }, 'a2')).toMatchObject({ kind: 'chat', workdir: null, approvalMode: 'ask' })
  })

  it('keeps a chosen effort and drops one that is not a plain name', () => {
    const parsed = parseConversation(
      { version: 1, participants: { claude: { effort: 'low' }, gpt: { effort: '--model x' } } },
      'a1',
    )
    expect(parsed.participants.claude.effort).toBe('low')
    expect(parsed.participants.gpt.effort).toBeNull()
  })

  it.each([null, [], 'text', { version: 2 }])('rejects %j', (raw) => {
    expect(() => parseConversation(raw, 'a1')).toThrow()
  })
})
