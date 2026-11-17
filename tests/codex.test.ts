import { describe, expect, it } from 'vitest'
import { CodexAdapter } from '../src/main/agents/codex'
import type { RpcConnection } from '../src/main/agents/jsonRpc'
import type { AgentRunRequest } from '../src/main/agents/types'
import type { AgentActivity } from '../src/shared/types'

/** A stand-in for `codex app-server` that records requests and lets the test push notifications. */
class FakeAppServer implements RpcConnection {
  onNotification: RpcConnection['onNotification'] = () => {}
  onServerRequest: RpcConnection['onServerRequest'] = () => null
  onClose: RpcConnection['onClose'] = () => {}
  readonly requests: { method: string; params: any }[] = []
  readonly notifications: string[] = []
  disposed = false
  /** `model_reasoning_effort` in the user's Codex settings. */
  configuredEffort: string | null = 'xhigh'
  private turnCount = 0

  async request<T>(method: string, params?: unknown): Promise<T> {
    this.requests.push({ method, params })
    switch (method) {
      case 'initialize':
        return { platformOs: 'macos' } as T
      case 'thread/start':
        return { thread: { id: 'thread-1' }, model: 'gpt-6-sol' } as T
      case 'thread/resume':
        return { thread: { id: (params as { threadId: string }).threadId }, model: 'gpt-6-sol' } as T
      case 'turn/start':
        this.turnCount += 1
        return { turn: { id: `turn-${this.turnCount}` } } as T
      case 'turn/interrupt':
        return {} as T
      case 'config/read':
        return { config: { model_reasoning_effort: this.configuredEffort } } as T
      case 'model/list':
        return {
          data: [
            { model: 'gpt-6.1-sol', isDefault: true, defaultReasoningEffort: 'low', supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'].map((reasoningEffort) => ({ reasoningEffort })) },
            { model: 'gpt-6-luna', isDefault: false, defaultReasoningEffort: 'medium', supportedReasoningEfforts: ['low', 'medium'].map((reasoningEffort) => ({ reasoningEffort })) },
          ],
          nextCursor: null,
        } as T
      default:
        throw new Error(`unexpected ${method}`)
    }
  }

  notify(method: string): void {
    this.notifications.push(method)
  }

  push(method: string, params: Record<string, unknown>): void {
    this.onNotification(method, { threadId: 'thread-1', ...params })
  }

  dispose(): void {
    this.disposed = true
  }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

function request(overrides: Partial<AgentRunRequest> = {}) {
  const texts: string[] = []
  const sessions: string[] = []
  const models: string[] = []
  const activities: AgentActivity[] = []
  const controller = new AbortController()
  const req: AgentRunRequest = {
    prompt: '【ユーザー → あなた】\nこんにちは',
    systemPrompt: 'SYS',
    sessionId: null,
    cwd: '/tmp/chat',
    model: null,
    effort: null,
    signal: controller.signal,
    onSession: (id) => sessions.push(id),
    onModel: (model) => models.push(model),
    onText: (text) => texts.push(text),
    onActivity: (activity) => activities.push(activity),
    ...overrides,
  }
  return { req, texts, sessions, models, activities, controller }
}

function setup() {
  const server = new FakeAppServer()
  const adapter = new CodexAdapter({ connect: async () => server, clientVersion: '0.1.0' })
  return { server, adapter }
}

describe('CodexAdapter', () => {
  it('starts a read-only thread, streams the reply and finishes with the turn', async () => {
    const { server, adapter } = setup()
    const { req, texts, sessions, models } = request()
    const result = adapter.run(req)
    await flush()

    expect(server.requests.map((r) => r.method)).toEqual(['initialize', 'thread/start', 'turn/start'])
    expect(server.notifications).toEqual(['initialized'])
    expect(server.requests[1]!.params).toEqual({
      cwd: '/tmp/chat',
      sandbox: 'read-only',
      approvalPolicy: 'never',
      developerInstructions: 'SYS',
    })
    expect(server.requests[2]!.params.input).toEqual([{ type: 'text', text: '【ユーザー → あなた】\nこんにちは', text_elements: [] }])
    expect(sessions).toEqual(['thread-1'])
    expect(models).toEqual(['gpt-6-sol'])

    server.push('item/agentMessage/delta', { turnId: 'turn-1', itemId: 'item-1', delta: 'こん' })
    server.push('item/agentMessage/delta', { turnId: 'turn-1', itemId: 'item-1', delta: 'にちは' })
    server.push('item/completed', { turnId: 'turn-1', item: { type: 'agentMessage', id: 'item-1', text: 'こんにちは' } })
    server.push('turn/completed', { turn: { id: 'turn-1', status: 'completed', error: null } })

    await expect(result).resolves.toEqual({ text: 'こんにちは', status: 'done' })
    expect(texts.join('')).toBe('こんにちは')
  })

  it('resumes a thread once per process, then reuses it', async () => {
    const { server, adapter } = setup()
    const first = request({ sessionId: 'thread-1', model: 'gpt-6-luna' })
    const done1 = adapter.run(first.req)
    await flush()
    server.push('turn/completed', { turn: { id: 'turn-1', status: 'completed', error: null } })
    await done1

    const second = request({ sessionId: 'thread-1' })
    const done2 = adapter.run(second.req)
    await flush()
    server.push('turn/completed', { turn: { id: 'turn-2', status: 'completed', error: null } })
    await done2

    // A resumed thread may carry an effort from an earlier run, so the CLI's own setting is looked up once and named.
    expect(server.requests.map((r) => r.method)).toEqual(['initialize', 'thread/resume', 'model/list', 'config/read', 'turn/start', 'turn/start'])
    expect(server.requests[4]!.params).toMatchObject({ effort: 'medium' }) // gpt-6-luna has no xhigh: its own default
    expect(server.requests[1]!.params).toMatchObject({ threadId: 'thread-1', model: 'gpt-6-luna', excludeTurns: true })
  })

  it('reports thinking, searching and tool use as they start', async () => {
    const { server, adapter } = setup()
    const { req, activities } = request()
    const result = adapter.run(req)
    await flush()
    const item = (type: string, extra: Record<string, unknown> = {}) => ({ turnId: 'turn-1', item: { type, id: `${type}-1`, ...extra } })
    server.push('item/started', item('userMessage'))
    server.push('item/started', item('reasoning', { summary: [], content: [] }))
    server.push('item/started', item('webSearch', { query: '', action: null }))
    server.push('item/completed', item('webSearch', { query: '東京 雨の日', action: null }))
    server.push('item/started', item('webSearch', { query: '美術館 東京', action: null }))
    server.push('item/started', item('commandExecution', { command: 'ls' }))
    server.push('item/completed', item('commandExecution', { command: 'ls' }))
    server.push('item/started', item('agentMessage', { text: '' }))
    server.push('item/completed', item('reasoning', { summary: [], content: [] }))
    server.push('turn/completed', { turn: { id: 'turn-1', status: 'completed', error: null } })
    await result

    expect(activities).toEqual([
      { kind: 'thinking' },
      { kind: 'searching' },
      { kind: 'thinking' },
      { kind: 'searching', detail: '美術館 東京' },
      { kind: 'working' },
      { kind: 'thinking' },
    ])
  })

  it('sends a chosen effort with the turn, and names the CLI setting again when switching back', async () => {
    const { server, adapter } = setup()
    const turn = async (effort: string | null, sessionId: string | null) => {
      const done = adapter.run(request({ effort, sessionId }).req)
      await flush()
      await flush()
      server.push('turn/completed', { turn: { id: `turn-${server.requests.filter((r) => r.method === 'turn/start').length}`, status: 'completed', error: null } })
      await done
      return server.requests.filter((r) => r.method === 'turn/start').at(-1)!.params
    }
    expect(await turn(null, null)).not.toHaveProperty('effort') // a new thread is at the CLI's setting
    expect(await turn('low', 'thread-1')).toMatchObject({ effort: 'low' })
    expect(await turn(null, 'thread-1')).toMatchObject({ effort: 'xhigh' }) // back to the user's Codex setting
    expect(await turn(null, 'thread-1')).not.toHaveProperty('effort')
  })

  it('names the CLI setting for a thread resumed from an earlier run', async () => {
    const { server, adapter } = setup()
    const done = adapter.run(request({ sessionId: 'thread-9' }).req)
    await flush()
    await flush()
    server.onNotification('turn/completed', { threadId: 'thread-9', turn: { id: 'turn-1', status: 'completed', error: null } })
    await done
    expect(server.requests.find((r) => r.method === 'turn/start')!.params).toMatchObject({ threadId: 'thread-9', effort: 'xhigh' })
  })

  it('lists the efforts of the model, with the CLI setting as the default', async () => {
    const { server, adapter } = setup()
    await expect(adapter.choices(null)).resolves.toEqual({ efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'xhigh' })
    // The configured effort does not exist for this model: its own default is used.
    await expect(adapter.choices('gpt-6-luna')).resolves.toEqual({ efforts: ['low', 'medium'], defaultEffort: 'medium' })
    expect(server.requests.filter((r) => r.method === 'model/list')).toHaveLength(1) // read once
  })

  it('falls back to the model default when nothing is configured', async () => {
    const { server, adapter } = setup()
    server.configuredEffort = null
    await expect(adapter.choices('gpt-6.1-sol')).resolves.toMatchObject({ defaultEffort: 'low' })
  })

  it('separates several agent messages in one turn with a blank line', async () => {
    const { server, adapter } = setup()
    const { req, texts } = request()
    const result = adapter.run(req)
    await flush()
    server.push('item/agentMessage/delta', { turnId: 'turn-1', itemId: 'a', delta: '一つ目' })
    server.push('item/agentMessage/delta', { turnId: 'turn-1', itemId: 'b', delta: '二つ目' })
    server.push('turn/completed', { turn: { id: 'turn-1', status: 'completed', error: null } })
    await expect(result).resolves.toEqual({ text: '一つ目\n\n二つ目', status: 'done' })
    expect(texts.join('')).toBe('一つ目\n\n二つ目')
  })

  it('interrupts the turn when stopped', async () => {
    const { server, adapter } = setup()
    const { req, controller } = request()
    const result = adapter.run(req)
    await flush()
    server.push('item/agentMessage/delta', { turnId: 'turn-1', itemId: 'a', delta: '途中' })
    controller.abort()
    await flush()
    expect(server.requests.at(-1)).toEqual({ method: 'turn/interrupt', params: { threadId: 'thread-1', turnId: 'turn-1' } })
    server.push('turn/completed', { turn: { id: 'turn-1', status: 'interrupted', error: null } })
    await expect(result).resolves.toEqual({ text: '途中', status: 'stopped' })
  })

  it('reports a failed turn', async () => {
    const { server, adapter } = setup()
    const { req } = request()
    const result = adapter.run(req)
    await flush()
    server.push('error', { turnId: 'turn-1', willRetry: false, error: { message: 'usage limit reached' } })
    server.push('turn/completed', { turn: { id: 'turn-1', status: 'failed', error: null } })
    await expect(result).rejects.toThrow('usage limit reached')
  })

  it('fails the turn when the app-server goes away', async () => {
    const { server, adapter } = setup()
    const { req } = request()
    const result = adapter.run(req)
    await flush()
    server.onClose(new Error('プロセスが終了しました'))
    await expect(result).rejects.toThrow('Codex CLI との接続が切れました')
  })
})
