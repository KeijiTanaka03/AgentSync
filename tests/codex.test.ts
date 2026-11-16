import { describe, expect, it } from 'vitest'
import { CodexAdapter } from '../src/main/agents/codex'
import type { RpcConnection } from '../src/main/agents/jsonRpc'
import type { AgentRunRequest } from '../src/main/agents/types'

/** A stand-in for `codex app-server` that records requests and lets the test push notifications. */
class FakeAppServer implements RpcConnection {
  onNotification: RpcConnection['onNotification'] = () => {}
  onServerRequest: RpcConnection['onServerRequest'] = () => null
  onClose: RpcConnection['onClose'] = () => {}
  readonly requests: { method: string; params: any }[] = []
  readonly notifications: string[] = []
  disposed = false
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
  const controller = new AbortController()
  const req: AgentRunRequest = {
    prompt: '【ユーザー → あなた】\nこんにちは',
    systemPrompt: 'SYS',
    sessionId: null,
    cwd: '/tmp/chat',
    model: null,
    signal: controller.signal,
    onSession: (id) => sessions.push(id),
    onModel: (model) => models.push(model),
    onText: (text) => texts.push(text),
    ...overrides,
  }
  return { req, texts, sessions, models, controller }
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

    expect(server.requests.map((r) => r.method)).toEqual(['initialize', 'thread/resume', 'turn/start', 'turn/start'])
    expect(server.requests[1]!.params).toMatchObject({ threadId: 'thread-1', model: 'gpt-6-luna', excludeTurns: true })
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
