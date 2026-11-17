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
      { type: 'agent:update', agent: { id: 'gpt', model: null, activeModel: null, effort: 'low', busy: false, activity: null } },
    ])

    orchestrator.send({ text: '急ぎで', to: 'all' })
    await flush()
    expect(gpt.calls[0]!.effort).toBe('low')
    expect(claude.calls[0]!.effort).toBeNull()
    expect(orchestrator.content().participants.gpt.effort).toBe('low')

    orchestrator.setEffort('gpt', null)
    expect(orchestrator.snapshot().state.agents.gpt.effort).toBeNull()
  })

  it('uses a chosen model from the next reply on, and shows the model the CLI reports', async () => {
    const { claude, orchestrator } = setup()
    orchestrator.setModel('claude', 'tiny')
    expect(orchestrator.info('claude')).toMatchObject({ model: 'tiny', activeModel: null })
    orchestrator.send({ text: 'hi', to: 'claude' })
    await flush()
    expect(claude.calls[0]!.model).toBe('tiny')
    claude.calls[0]!.onModel('tiny-2026')
    expect(orchestrator.info('claude')).toMatchObject({ model: 'tiny', activeModel: 'tiny-2026' })
    expect(orchestrator.content().participants.claude.model).toBe('tiny') // the choice is kept, not what was reported

    orchestrator.setModel('claude', null)
    expect(orchestrator.info('claude')).toMatchObject({ model: null, activeModel: null })
  })

  it('asks the agent what can be chosen for its current model', async () => {
    const { gpt, orchestrator } = setup()
    orchestrator.send({ text: 'hi', to: 'gpt' })
    await flush()
    gpt.reply('hello')
    await flush()
    await expect(orchestrator.choices('gpt')).resolves.toMatchObject({ efforts: ['low', 'medium', 'high'], defaultEffort: 'medium' })
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

describe('Orchestrator dialogue mode', () => {
  const start = '【AgentSync からのお知らせ】\nここから「対話モード」です。'

  /** A topic both agents have answered, GPT last. */
  async function debate() {
    const t = setup()
    t.orchestrator.send({ text: '在宅勤務は生産的？議論して', to: 'all' })
    await flush()
    t.claude.reply('生産的です')
    t.gpt.reply('そうとも限りません')
    await flush()
    return t
  }

  it('starts with the AI that did not speak last, then alternates; each reply goes to the other', async () => {
    const { claude, gpt, orchestrator, messages } = await debate()
    orchestrator.setDialogue(true)
    await flush()

    expect(orchestrator.snapshot().state.dialogue).toEqual({ next: 'claude', turns: 0 })
    expect(messages().at(-2)).toMatchObject({ from: 'system', to: 'all', notice: 'dialogue-start', text: 'ここから対話モード · Claude から開始' })
    expect(claude.calls).toHaveLength(2)
    expect(claude.calls[1]!.prompt).toContain('【GPT → ユーザー】\nそうとも限りません\n\n' + start + 'あなたと GPT が交互に発言し')
    expect(gpt.pending).toBe(0)

    claude.reply('通勤がなくなります')
    await flush()
    expect(messages().find((m) => m.text === '通勤がなくなります')).toMatchObject({ from: 'claude', to: 'gpt' })
    expect(orchestrator.snapshot().state.dialogue).toEqual({ next: 'gpt', turns: 1 })
    expect(gpt.calls).toHaveLength(2)
    expect(gpt.calls[1]!.prompt).toContain(start + 'あなたと Claude が交互に発言し')
    expect(gpt.calls[1]!.prompt.endsWith('【Claude → あなた】\n通勤がなくなります')).toBe(true)

    gpt.reply('でも新人は育ちにくい')
    await flush()
    expect(claude.calls).toHaveLength(3)
    expect(claude.calls[2]!.prompt).toBe('【GPT → あなた】\nでも新人は育ちにくい')
    expect(orchestrator.snapshot().state.dialogue).toEqual({ next: 'claude', turns: 2 })
    expect(orchestrator.inDialogue).toBe(true)
  })

  it('hands what the user says meanwhile to the next speaker and keeps going', async () => {
    const { claude, gpt, orchestrator } = await debate()
    orchestrator.setDialogue(true)
    await flush()
    orchestrator.send({ text: '新人の育成に絞って', to: 'all' })
    await flush()
    expect(gpt.pending).toBe(0) // no extra reply: it waits for its turn
    expect(claude.pending).toBe(1)

    claude.reply('通勤がなくなります')
    await flush()
    const prompt = gpt.calls.at(-1)!.prompt
    expect(prompt.indexOf('【ユーザー → 全員】\n新人の育成に絞って')).toBeGreaterThan(prompt.indexOf(start))
    expect(orchestrator.inDialogue).toBe(true)
  })

  it('stops when turned off: the reply under way is stopped and nobody else is asked', async () => {
    const { claude, gpt, orchestrator, messages } = await debate()
    orchestrator.setDialogue(true)
    await flush()
    orchestrator.setDialogue(false)
    await flush()

    expect(orchestrator.snapshot().state.dialogue).toBeNull()
    expect(messages().at(-2)).toMatchObject({ from: 'claude', status: 'stopped' })
    expect(messages().at(-1)).toMatchObject({ from: 'system', notice: 'dialogue-stop', text: '対話モードを止めました' })
    expect(gpt.calls).toHaveLength(1)
    expect(claude.pending).toBe(0)

    // Turning it on again continues from there, with GPT (Claude spoke last).
    orchestrator.setDialogue(true)
    await flush()
    expect(gpt.calls).toHaveLength(2)
    expect(gpt.calls[1]!.prompt).toContain('【AgentSync からのお知らせ】\n対話モードが終わりました。')
  })

  it('stops on an error, and with the stop button', async () => {
    const first = await debate()
    first.orchestrator.setDialogue(true)
    await flush()
    first.claude.fail('使用枠の上限に達しました')
    await flush()
    expect(first.orchestrator.inDialogue).toBe(false)
    expect(first.messages().at(-1)).toMatchObject({ notice: 'dialogue-stop', text: 'エラーが起きたので対話モードを止めました' })
    expect(first.gpt.calls).toHaveLength(1)

    const second = await debate()
    second.orchestrator.setDialogue(true)
    await flush()
    second.orchestrator.stop()
    await flush()
    expect(second.orchestrator.inDialogue).toBe(false)
    expect(second.messages().at(-1)).toMatchObject({ notice: 'dialogue-stop', text: '対話モードを止めました' })
  })

  it('stops when the next speaker has nothing new to answer', async () => {
    const { claude, gpt, orchestrator, messages } = await debate()
    orchestrator.setDialogue(true)
    await flush()
    claude.reply('通勤がなくなります')
    await flush()
    gpt.reply('でも新人は育ちにくい')
    await flush()
    claude.reply('') // GPT has seen everything else, so it has nothing to answer
    await flush()
    expect(orchestrator.inDialogue).toBe(false)
    expect(messages().at(-1)).toMatchObject({ notice: 'dialogue-stop', text: '次の話者に渡す発言がないので対話モードを止めました' })
    expect(gpt.calls).toHaveLength(2)
  })

  it('waits for replies already under way before the first turn', async () => {
    const { claude, gpt, orchestrator, messages } = setup()
    orchestrator.send({ text: 'お題です', to: 'all' })
    await flush()
    orchestrator.setDialogue(true) // both are still replying; GPT's reply is the last message
    await flush()
    expect(messages().at(-1)).toMatchObject({ text: 'ここから対話モード · Claude から開始' })
    claude.reply('A')
    await flush()
    expect(claude.calls).toHaveLength(1) // still waiting for GPT
    gpt.reply('B')
    await flush()
    expect(claude.calls).toHaveLength(2)
    expect(claude.calls[1]!.prompt.startsWith('【GPT → ユーザー】\nB')).toBe(true)
  })

  it('starts with GPT when you spoke to GPT last', () => {
    const { orchestrator, messages } = setup({
      title: 't',
      messages: [{ id: 1, from: 'user', to: 'gpt', text: 'GPT から話して', at: '2026-11-17T05:00:00.000Z', status: 'done' }],
      participants: {
        claude: { model: null, effort: null, sessionId: null, delivered: [] },
        gpt: { model: null, effort: null, sessionId: null, delivered: [] },
      },
    })
    orchestrator.setDialogue(true)
    expect(orchestrator.snapshot().state.dialogue).toEqual({ next: 'gpt', turns: 0 })
    expect(messages().at(-2)!.text).toBe('ここから対話モード · GPT から開始')
  })

  it('closes a dialogue the app was in when it quit', () => {
    const { messages } = setup({
      title: 't',
      messages: [
        { id: 1, from: 'user', to: 'all', text: 'お題', at: '2026-11-17T05:00:00.000Z', status: 'done' },
        { id: 2, from: 'system', to: 'all', text: 'ここから対話モード · Claude から開始', at: '2026-11-17T05:00:01.000Z', status: 'done', notice: 'dialogue-start' },
        { id: 3, from: 'claude', to: 'gpt', text: '途中', at: '2026-11-17T05:00:02.000Z', status: 'streaming' },
      ],
      participants: {
        claude: { model: null, effort: null, sessionId: 'c', delivered: [1, 2] },
        gpt: { model: null, effort: null, sessionId: 'g', delivered: [1] },
      },
    })
    expect(messages().map((m) => [m.id, m.from, m.status, m.notice])).toEqual([
      [1, 'user', 'done', undefined],
      [2, 'system', 'done', 'dialogue-start'],
      [3, 'claude', 'stopped', undefined],
      [4, 'system', 'done', 'dialogue-stop'],
    ])
  })
})

