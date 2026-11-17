import { describe, expect, it } from 'vitest'
import { Orchestrator } from '../src/main/chat/orchestrator'
import type { ConversationContent } from '../src/main/store/conversationStore'
import type { ChatEventEnvelope } from '../src/shared/types'
import { FakeAgent, flush } from './fakeAgent'

function setup(initial?: ConversationContent) {
  const claude = new FakeAgent('claude')
  const gpt = new FakeAgent('gpt')
  const events: ChatEventEnvelope[] = []
  const orchestrator = new Orchestrator({
    adapters: { claude, gpt },
    cwd: '/tmp/agentsync-test',
    emit: (envelope) => events.push(envelope),
    now: () => new Date('2026-11-16T05:00:00.000Z'),
    ...(initial ? { initial } : {}),
  })
  const messages = () => orchestrator.snapshot().state.messages
  return { claude, gpt, events, orchestrator, messages }
}

describe('Orchestrator', () => {
  it('sends a message for everyone to both agents in parallel', async () => {
    const { claude, gpt, orchestrator, messages } = setup()
    orchestrator.send({ text: 'DB は何がいい？', to: 'all' })
    await flush()

    expect(claude.calls).toHaveLength(1)
    expect(gpt.calls).toHaveLength(1)
    expect(claude.calls[0]!.prompt).toBe('【ユーザー → 全員】\nDB は何がいい？')
    expect(claude.calls[0]!.sessionId).toBeNull()
    expect(messages().map((m) => [m.from, m.status])).toEqual([
      ['user', 'done'],
      ['claude', 'streaming'],
      ['gpt', 'streaming'],
    ])

    gpt.reply('Postgres です')
    claude.reply('SQLite で十分です')
    await flush()

    expect(messages().map((m) => [m.from, m.to, m.text, m.status])).toEqual([
      ['user', 'all', 'DB は何がいい？', 'done'],
      ['claude', 'user', 'SQLite で十分です', 'done'],
      ['gpt', 'user', 'Postgres です', 'done'],
    ])
    expect(orchestrator.snapshot().state.agents.claude.busy).toBe(false)
  })

  it('gives an agent only what it has not seen, including the other agent’s reply', async () => {
    const { claude, gpt, orchestrator } = setup()
    orchestrator.send({ text: 'DB は何がいい？', to: 'all' })
    await flush()
    claude.reply('SQLite で十分です')
    gpt.reply('Postgres です')
    await flush()

    orchestrator.send({ text: 'GPT の意見をどう思う？', to: 'claude' })
    await flush()

    expect(gpt.calls).toHaveLength(1) // GPT was not addressed
    expect(claude.calls).toHaveLength(2)
    expect(claude.calls[1]!.sessionId).toBe('claude-session')
    expect(claude.calls[1]!.prompt).toBe('【GPT → ユーザー】\nPostgres です\n\n【ユーザー → あなた】\nGPT の意見をどう思う？')
  })

  it('queues a message for a busy agent and sends it after the current reply', async () => {
    const { claude, orchestrator } = setup()
    orchestrator.send({ text: '一つ目', to: 'claude' })
    await flush()
    orchestrator.send({ text: '二つ目', to: 'claude' })
    await flush()
    expect(claude.calls).toHaveLength(1)

    claude.reply('一つ目への返事')
    await flush()
    expect(claude.calls).toHaveLength(2)
    expect(claude.calls[1]!.prompt).toBe('【ユーザー → あなた】\n二つ目')
  })

  it('shows an error and hands the same messages over again next time', async () => {
    const { claude, orchestrator, messages } = setup()
    orchestrator.send({ text: 'こんにちは', to: 'claude' })
    await flush()
    claude.fail('使用枠の上限に達しました')
    await flush()

    expect(messages()[1]).toMatchObject({ from: 'claude', status: 'error', error: '使用枠の上限に達しました' })

    orchestrator.send({ text: 'もう一度', to: 'claude' })
    await flush()
    expect(claude.calls[1]!.prompt).toBe('【ユーザー → あなた】\nこんにちは\n\n【ユーザー → あなた】\nもう一度')
  })

  it('stops replies in progress', async () => {
    const { claude, gpt, orchestrator, messages } = setup()
    orchestrator.send({ text: '長い話をして', to: 'all' })
    await flush()
    orchestrator.stop()
    await flush()

    expect(messages().slice(1).map((m) => [m.from, m.status, m.text])).toEqual([
      ['claude', 'stopped', '途中まで'],
      ['gpt', 'stopped', '途中まで'],
    ])
    expect(claude.calls[0]!.signal.aborted).toBe(true)
    expect(gpt.pending).toBe(0)
    expect(orchestrator.snapshot().state.agents.gpt.busy).toBe(false)
  })

  it('ignores blank messages', () => {
    const { claude, orchestrator, messages } = setup()
    orchestrator.send({ text: '   ', to: 'all' })
    expect(messages()).toEqual([])
    expect(claude.calls).toHaveLength(0)
  })

  it('numbers events so the renderer can merge them with a snapshot', async () => {
    const { claude, events, orchestrator } = setup()
    orchestrator.send({ text: 'hi', to: 'claude' })
    await flush()
    claude.reply('hello')
    await flush()

    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1))
    expect(orchestrator.snapshot().seq).toBe(events.length)
    expect(events.map((e) => e.event.type)).toEqual([
      'message:add', // user
      'title:update', // named after the first message
      'agent:update', // busy, thinking
      'message:add', // empty reply
      'agent:activity', // writing
      'message:append',
      'message:update',
      'agent:update', // idle
    ])
  })

  it('shows what each agent is doing while both reply at once', async () => {
    const { claude, gpt, events, orchestrator } = setup()
    const agents = () => orchestrator.snapshot().state.agents
    orchestrator.send({ text: '雨の日に何する？', to: 'all' })
    await flush()
    expect(agents().claude).toMatchObject({ busy: true, activity: { kind: 'thinking' } })
    expect(agents().gpt).toMatchObject({ busy: true, activity: { kind: 'thinking' } })

    gpt.activity({ kind: 'searching', detail: '東京 雨' })
    gpt.activity({ kind: 'searching', detail: '東京 雨' }) // unchanged: no second event
    expect(agents().gpt.activity).toEqual({ kind: 'searching', detail: '東京 雨' })
    expect(events.filter((e) => e.event.type === 'agent:activity')).toHaveLength(1)

    claude.reply('美術館はどう？')
    await flush()
    expect(agents().claude).toMatchObject({ busy: false, activity: null })
    expect(agents().gpt).toMatchObject({ busy: true, activity: { kind: 'searching', detail: '東京 雨' } })

    orchestrator.stop()
    await flush()
    expect(agents().gpt).toMatchObject({ busy: false, activity: null })
  })

  it('names a new conversation after the first message, once', () => {
    const { orchestrator } = setup()
    expect(orchestrator.snapshot().state.title).toBe('新しい会話')
    orchestrator.send({ text: '\nDB は何がいい？\n詳しく教えて', to: 'claude' })
    expect(orchestrator.snapshot().state.title).toBe('DB は何がいい？')
    orchestrator.send({ text: '別の話題', to: 'claude' })
    expect(orchestrator.snapshot().state.title).toBe('DB は何がいい？')
  })

  it('keeps a title the user chose before the first message', () => {
    const { orchestrator } = setup()
    orchestrator.setTitle('設計相談')
    orchestrator.send({ text: 'DB は何がいい？', to: 'claude' })
    expect(orchestrator.snapshot().state.title).toBe('設計相談')
  })

  it('continues a saved conversation: same sessions, only what each agent has not seen', async () => {
    const first = setup()
    first.orchestrator.send({ text: 'DB は？', to: 'all' })
    await flush()
    first.claude.reply('SQLite')
    first.gpt.reply('Postgres')
    await flush()
    first.orchestrator.send({ text: 'GPT の意見は？', to: 'claude' })
    await flush()
    first.claude.reply('賛成です')
    await flush()
    const saved = first.orchestrator.content()
    // Claude's first reply was still streaming when GPT started, so GPT has not had it yet.
    expect(saved.participants.gpt).toEqual({ model: null, effort: null, sessionId: 'gpt-session', delivered: [1] })

    // As if the app had been restarted.
    const second = setup(saved)
    expect(second.messages()).toEqual(first.messages())
    second.orchestrator.send({ text: 'まとめて', to: 'gpt' })
    await flush()
    expect(second.gpt.calls[0]!.sessionId).toBe('gpt-session')
    expect(second.gpt.calls[0]!.prompt).toBe(
      '【Claude → ユーザー】\nSQLite\n\n【ユーザー → Claude】\nGPT の意見は？\n\n【Claude → ユーザー】\n賛成です\n\n【ユーザー → あなた】\nまとめて',
    )
    expect(second.messages().slice(-2).map((m) => [m.id, m.from])).toEqual([
      [6, 'user'],
      [7, 'gpt'],
    ])
    expect(second.orchestrator.snapshot().state.title).toBe('DB は？')
  })

  it('uses the chosen effort from the next reply on, and keeps it with the conversation', async () => {
    const { claude, gpt, events, orchestrator } = setup()
    orchestrator.setEffort('gpt', 'low')
    orchestrator.setEffort('gpt', 'low') // unchanged: no second event
    expect(events.filter((e) => e.event.type === 'agent:update').map((e) => e.event)).toEqual([
      { type: 'agent:update', agent: { id: 'gpt', model: null, effort: 'low', busy: false, activity: null } },
    ])

    orchestrator.send({ text: '急ぎで', to: 'all' })
    await flush()
    expect(gpt.calls[0]!.effort).toBe('low')
    expect(claude.calls[0]!.effort).toBeNull()
    expect(orchestrator.content().participants.gpt.effort).toBe('low')

    orchestrator.setEffort('gpt', null)
    expect(orchestrator.snapshot().state.agents.gpt.effort).toBeNull()
  })

  it('asks the agent what can be chosen for its current model', async () => {
    const { gpt, orchestrator } = setup()
    orchestrator.send({ text: 'hi', to: 'gpt' })
    await flush()
    gpt.reply('hello')
    await flush()
    await expect(orchestrator.choices('gpt')).resolves.toEqual({ efforts: ['low', 'medium', 'high'], defaultEffort: 'medium' })
    expect(gpt.choiceModels).toEqual([null])
  })

  it('starts a new conversation with the given efforts, but a saved one keeps its own', () => {
    const claude = new FakeAgent('claude')
    const gpt = new FakeAgent('gpt')
    const options = { adapters: { claude, gpt }, cwd: '/tmp/agentsync-test', emit: () => {}, efforts: { gpt: 'low' } }
    expect(new Orchestrator(options).snapshot().state.agents.gpt.effort).toBe('low')
    const saved = new Orchestrator({
      ...options,
      initial: {
        title: '前の会話',
        messages: [],
        participants: {
          claude: { model: null, effort: 'max', sessionId: null, delivered: [] },
          gpt: { model: null, effort: null, sessionId: null, delivered: [] },
        },
      },
    })
    expect(saved.snapshot().state.agents.claude.effort).toBe('max')
    expect(saved.snapshot().state.agents.gpt.effort).toBeNull()
  })

  it('treats a reply that was streaming when the app closed as stopped', () => {
    const { messages } = setup({
      title: '途中',
      messages: [{ id: 1, from: 'claude', to: 'user', text: '途中まで', at: '2026-11-16T05:00:00.000Z', status: 'streaming' }],
      participants: {
        claude: { model: 'haiku', effort: null, sessionId: 's1', delivered: [] },
        gpt: { model: null, effort: null, sessionId: null, delivered: [] },
      },
    })
    expect(messages()[0]!.status).toBe('stopped')
  })
})
