import { describe, expect, it } from 'vitest'
import type { AgentAdapter, AgentRunRequest, AgentRunResult } from '../src/main/agents/types'
import { Orchestrator } from '../src/main/chat/orchestrator'
import type { AgentId, ChatEventEnvelope } from '../src/shared/types'

/** An agent whose replies the test controls. */
class FakeAgent implements AgentAdapter {
  readonly calls: AgentRunRequest[] = []
  private readonly open: { request: AgentRunRequest; resolve(r: AgentRunResult): void; reject(e: Error): void }[] = []

  constructor(readonly id: AgentId) {}

  run(request: AgentRunRequest): Promise<AgentRunResult> {
    this.calls.push(request)
    return new Promise((resolve, reject) => {
      const turn = { request, resolve, reject }
      this.open.push(turn)
      request.signal.addEventListener('abort', () => {
        this.open.splice(this.open.indexOf(turn), 1)
        resolve({ text: '途中まで', status: 'stopped' })
      })
    })
  }

  reply(text: string): void {
    const turn = this.open.shift()!
    turn.request.onSession(`${this.id}-session`)
    turn.request.onText(text)
    turn.resolve({ text, status: 'done' })
  }

  fail(message: string): void {
    this.open.shift()!.reject(new Error(message))
  }

  get pending(): number {
    return this.open.length
  }

  dispose(): void {}
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

function setup() {
  const claude = new FakeAgent('claude')
  const gpt = new FakeAgent('gpt')
  const events: ChatEventEnvelope[] = []
  const orchestrator = new Orchestrator({
    adapters: { claude, gpt },
    cwd: '/tmp/agentsync-test',
    emit: (envelope) => events.push(envelope),
    now: () => new Date('2026-11-16T05:00:00.000Z'),
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
      'agent:update', // busy
      'message:add', // empty reply
      'message:append',
      'message:update',
      'agent:update', // idle
    ])
  })
})
