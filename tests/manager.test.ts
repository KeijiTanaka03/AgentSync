import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ChatManager } from '../src/main/chat/manager'
import { ConversationStore } from '../src/main/store/conversationStore'
import type { ConversationEventEnvelope, ConversationSummary } from '../src/shared/types'
import { FakeAgent, flush } from './fakeAgent'

/** Waits for the reply to finish and for the (debounced) save that follows it. */
async function settle(): Promise<void> {
  await flush()
  await flush()
}

function setup(directory = mkdtempSync(path.join(tmpdir(), 'agentsync-manager-')), efforts: Partial<Record<'claude' | 'gpt', string | null>> = {}) {
  const claude = new FakeAgent('claude')
  const gpt = new FakeAgent('gpt')
  const events: ConversationEventEnvelope[] = []
  const lists: ConversationSummary[][] = []
  const savedEfforts: Record<string, string | null>[] = []
  let clock = Date.parse('2026-11-16T05:00:00.000Z')
  let nextId = 1
  const store = new ConversationStore(path.join(directory, 'conversations'))
  const manager = new ChatManager({
    store,
    adapters: { claude, gpt },
    cwd: '/tmp/agentsync-test',
    emitEvent: (envelope) => events.push(envelope),
    emitConversations: (list) => lists.push(list),
    saveDelayMs: 0,
    now: () => new Date((clock += 1000)),
    newId: () => `c${nextId++}`,
    efforts,
    onEffortsChange: (next) => savedEfforts.push(next),
  })
  const file = (id: string) => path.join(directory, 'conversations', `${id}.json`)
  const read = (id: string) => JSON.parse(readFileSync(file(id), 'utf8'))
  return { directory, claude, gpt, events, lists, manager, file, read, savedEfforts }
}

describe('ChatManager', () => {
  it('writes a new conversation only once it has a message', async () => {
    const { manager, claude, file, read, lists } = setup()
    const id = manager.create()
    expect(manager.list()).toMatchObject([{ id, title: '新しい会話', busy: false }])
    await flush()
    expect(existsSync(file(id))).toBe(false)

    manager.send(id, { text: 'DB は何がいい？', to: 'claude' })
    expect(manager.list()[0]).toMatchObject({ title: 'DB は何がいい？', busy: true })
    claude.reply('SQLite で十分です')
    await settle()

    const saved = read(id)
    expect(saved).toMatchObject({ version: 1, id, kind: 'chat', workdir: null, title: 'DB は何がいい？' })
    expect(saved.messages.map((m: { text: string }) => m.text)).toEqual(['DB は何がいい？', 'SQLite で十分です'])
    expect(saved.participants.claude).toEqual({ model: null, effort: null, sessionId: 'claude-session', delivered: [1] })
    expect(lists.at(-1)![0]!.busy).toBe(false)
  })

  it('reuses an empty conversation instead of making another', () => {
    const { manager } = setup()
    const first = manager.create()
    expect(manager.create()).toBe(first)
    expect(manager.list()).toHaveLength(1)
  })

  it('tags events with their conversation', async () => {
    const { manager, events } = setup()
    const id = manager.create()
    manager.send(id, { text: 'hi', to: 'gpt' })
    expect(events.length).toBeGreaterThan(0)
    expect(events.every((e) => e.conversationId === id)).toBe(true)
  })

  it('moves a conversation to the top when it gets a new message', async () => {
    const { manager, claude } = setup()
    const a = manager.create()
    manager.send(a, { text: '一つ目', to: 'claude' })
    claude.reply('はい')
    const b = manager.create()
    manager.send(b, { text: '二つ目', to: 'claude' })
    claude.reply('はい')
    expect(manager.list().map((c) => c.id)).toEqual([b, a])
    manager.send(a, { text: '戻ってきました', to: 'claude' })
    expect(manager.list().map((c) => c.id)).toEqual([a, b])
  })

  it('renames a conversation and keeps the name', async () => {
    const { manager, claude, read } = setup()
    const id = manager.create()
    manager.send(id, { text: 'DB は？', to: 'claude' })
    claude.reply('SQLite')
    manager.rename(id, '設計相談')
    await settle()
    expect(manager.list()[0]!.title).toBe('設計相談')
    expect(read(id).title).toBe('設計相談')
  })

  it('deletes a conversation, stopping its reply and ignoring anything it says afterwards', async () => {
    const { manager, claude, file, events } = setup()
    const id = manager.create()
    manager.send(id, { text: '長い話をして', to: 'claude' })
    await flush()
    expect(existsSync(file(id))).toBe(true)

    const eventCount = events.length
    manager.delete(id)
    await flush()
    expect(claude.calls[0]!.signal.aborted).toBe(true)
    expect(existsSync(file(id))).toBe(false) // not written again by the stopped reply
    expect(events).toHaveLength(eventCount)
    expect(manager.list()).toEqual([])
    expect(() => manager.snapshot(id)).toThrow('会話が見つかりません')
  })

  it('continues saved conversations after a restart', async () => {
    const first = setup()
    const id = first.manager.create()
    first.manager.send(id, { text: 'DB は？', to: 'all' })
    first.claude.reply('SQLite')
    first.gpt.reply('Postgres')
    await flush()
    first.manager.dispose()
    expect(first.claude.disposed && first.gpt.disposed).toBe(true)

    const second = setup(first.directory)
    expect(second.manager.list()).toMatchObject([{ id, title: 'DB は？', busy: false }])
    expect(second.manager.snapshot(id).state.messages.map((m) => m.text)).toEqual(['DB は？', 'SQLite', 'Postgres'])
    second.manager.send(id, { text: 'GPT はどう？', to: 'claude' })
    expect(second.claude.calls[0]!.sessionId).toBe('claude-session')
    expect(second.claude.calls[0]!.prompt).toBe('【GPT → ユーザー】\nPostgres\n\n【ユーザー → あなた】\nGPT はどう？')
  })

  it('keeps the text of a reply cut off by quitting', async () => {
    const first = setup()
    const id = first.manager.create()
    first.manager.send(id, { text: '長い話をして', to: 'claude' })
    await flush()
    first.claude.calls[0]!.onText('途中まで書いた')
    first.manager.dispose()

    const second = setup(first.directory)
    expect(second.manager.snapshot(id).state.messages[1]).toMatchObject({ text: '途中まで書いた', status: 'stopped' })
  })

  it('reports a conversation file that cannot be read when it is opened', () => {
    const { manager } = setup()
    expect(() => manager.snapshot('nope')).toThrow('会話が見つかりません')
  })
  it('keeps a chosen effort for the conversation and for new ones', async () => {
    const { manager, gpt, read, savedEfforts } = setup()
    const first = manager.create()
    manager.setEffort(first, 'gpt', 'low')
    expect(savedEfforts).toEqual([{ claude: null, gpt: 'low' }])
    expect(manager.snapshot(first).state.agents.gpt.effort).toBe('low')

    // The empty conversation is reused, and a new one starts with the same choice.
    expect(manager.create()).toBe(first)
    manager.send(first, { text: '急ぎ', to: 'gpt' })
    gpt.reply('はい')
    await settle()
    expect(read(first).participants.gpt.effort).toBe('low')
    const second = manager.create()
    expect(second).not.toBe(first)
    expect(manager.snapshot(second).state.agents.gpt.effort).toBe('low')

    manager.setEffort(second, 'gpt', 'low') // unchanged: nothing more to save
    expect(savedEfforts).toHaveLength(1)
  })

  it('starts with the efforts it was given and updates an empty conversation already open', () => {
    const { manager } = setup(undefined, { claude: 'high' })
    const first = manager.create()
    expect(manager.snapshot(first).state.agents.claude.effort).toBe('high')
    const other = manager.create()
    expect(other).toBe(first)
  })
})
