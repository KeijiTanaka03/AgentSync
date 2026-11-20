import { describe, expect, it, vi } from 'vitest'
import * as childProcess from 'node:child_process'
import { CodexAdapter, unwrapShell } from '../src/main/agents/codex'
import type { RpcConnection } from '../src/main/agents/jsonRpc'
import type { AgentRunRequest } from '../src/main/agents/types'
import type { AgentActivity, TokenUsage, ToolLogEntry } from '../src/shared/types'
import type { ApprovalRequest } from '../src/main/agents/types'

vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof childProcess>()
  return { ...original, execFile: vi.fn(original.execFile) }
})

/** A stand-in for `codex app-server` that records requests and lets the test push notifications. */
class FakeAppServer implements RpcConnection {
  onNotification: RpcConnection['onNotification'] = () => {}
  onServerRequest: RpcConnection['onServerRequest'] = () => null
  onClose: RpcConnection['onClose'] = () => {}
  readonly requests: { method: string; params: any }[] = []
  readonly notifications: string[] = []
  disposed = false
  /** `model_reasoning_effort` and `model` in the user's Codex settings. */
  configuredEffort: string | null = 'xhigh'
  configuredModel: string | null = null
  /** Connectors (MCP servers) set up in Codex. */
  mcpServers: Record<string, unknown> = {}
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
      case 'turn/steer':
      case 'turn/interrupt':
        return {} as T
      case 'mcpServerStatus/list': {
        // The endpoint the thread's connection really uses (its origin), as Codex reports it.
        const { serverName } = params as { serverName: string }
        const server = this.mcpServers[serverName] as { url?: string } | undefined
        return { data: server ? [{ name: serverName, httpOrigin: server.url ? new URL(server.url).origin : null }] : [] } as T
      }
      case 'config/read':
        return { config: { model: this.configuredModel, model_reasoning_effort: this.configuredEffort, mcp_servers: this.mcpServers } } as T
      case 'model/list':
        return {
          data: [
            { model: 'gpt-6.1-sol', displayName: 'GPT-6.1 Sol', description: 'Frontier', isDefault: true, defaultReasoningEffort: 'low', supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'].map((reasoningEffort) => ({ reasoningEffort })) },
            { model: 'gpt-6-luna', displayName: 'GPT-6 Luna', description: 'Fast', isDefault: false, defaultReasoningEffort: 'medium', supportedReasoningEfforts: ['low', 'medium'].map((reasoningEffort) => ({ reasoningEffort })) },
            { model: 'gpt-internal', displayName: 'Internal', hidden: true, isDefault: false, defaultReasoningEffort: 'low', supportedReasoningEfforts: [] },
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
    askUser: async () => null,
    sessionId: null,
    cwd: '/tmp/chat',
    model: null,
    effort: null,
    access: 'chat',
    approval: 'ask',
    signal: controller.signal,
    onSession: (id) => sessions.push(id),
    onModel: (model) => models.push(model),
    onText: (text) => texts.push(text),
    onActivity: (activity) => activities.push(activity),
    onTool: () => {},
    requestApproval: async () => 'deny',
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
  it('reports usage for the active reply across several requests without counting repeats or the resumed history', async () => {
    const { server, adapter } = setup()
    const reports: TokenUsage[] = []
    const counts = (inputTokens: number, cachedInputTokens: number, cacheWriteInputTokens: number, outputTokens: number) =>
      ({ inputTokens, cachedInputTokens, cacheWriteInputTokens, outputTokens })
    const usage = (turnId: string, total: TokenUsage, last: TokenUsage) =>
      server.push('thread/tokenUsage/updated', { turnId, tokenUsage: { total, last } })

    const first = adapter.run(request({ sessionId: 'thread-1', onUsage: (value) => reports.push(value) }).req)
    await flush()
    const afterRequest = counts(1050, 640, 10, 82)
    const afterTool = counts(1110, 690, 13, 85)
    usage('turn-1', afterRequest, counts(50, 40, 2, 2))
    usage('turn-1', afterRequest, counts(50, 40, 2, 2))
    usage('turn-1', afterTool, counts(60, 50, 3, 3))
    // Re-estimating the context after compaction can change "last" without any new spend.
    usage('turn-1', afterTool, counts(0, 0, 0, 0))
    server.push('turn/completed', { turn: { id: 'turn-1', status: 'completed' } })
    await first

    const second = adapter.run(request({ sessionId: 'thread-1', onUsage: (value) => reports.push(value) }).req)
    await flush()
    usage('turn-2', afterTool, counts(60, 50, 3, 3))
    usage('turn-2', counts(1200, 770, 13, 95), counts(90, 80, 0, 10))
    server.push('turn/completed', { turn: { id: 'turn-2', status: 'interrupted' } })
    await second

    expect(reports).toEqual([counts(110, 90, 5, 5), counts(90, 80, 0, 10)])
  })

  it('does not report old usage replayed by a rate-limit failure on the first turn after resume', async () => {
    const { server, adapter } = setup()
    const reports: TokenUsage[] = []
    const reply = adapter.run(request({ sessionId: 'thread-1', onUsage: (value) => reports.push(value) }).req)
    await flush()
    server.push('thread/tokenUsage/updated', { turnId: 'turn-1', tokenUsage: {
      total: { inputTokens: 1000, cachedInputTokens: 800, outputTokens: 100 },
      last: { inputTokens: 50, cachedInputTokens: 40, outputTokens: 20 },
    } })
    server.push('turn/completed', { turn: { id: 'turn-1', status: 'failed', error: { message: 'rate limit' } } })
    await expect(reply).rejects.toThrow('rate limit')
    expect(reports).toEqual([])
  })

  it('steers the active turn and stops accepting follow-ups after completion', async () => {
    const { server, adapter } = setup()
    let steer!: (text: string) => Promise<boolean>
    const reply = adapter.run(request({ onSteer: (send) => { steer = send } }).req)
    await flush()
    await expect(steer('テスト不要です')).resolves.toBe(true)
    expect(server.requests.at(-1)).toMatchObject({
      method: 'turn/steer',
      params: { threadId: 'thread-1', expectedTurnId: 'turn-1', input: [{ text: 'テスト不要です' }] },
    })
    server.push('turn/completed', { turn: { id: 'turn-1', status: 'completed' } })
    await reply
    await expect(steer('追記')).resolves.toBe(false)
  })

  it('uses native localImage items for attached images', async () => {
    const { server, adapter } = setup()
    const { req } = request({ attachments: [
      { name: 'screen.png', path: '/tmp/screen.png', size: 40, mediaType: 'image/png' },
      { name: 'notes.txt', path: '/tmp/notes.txt', size: 10 },
    ] })
    const reply = adapter.run(req)
    await flush()
    expect(server.requests.find((entry) => entry.method === 'turn/start')!.params.input).toEqual([
      { type: 'text', text: req.prompt, text_elements: [] },
      { type: 'localImage', path: '/tmp/screen.png' },
    ])
    server.push('turn/completed', { turn: { id: 'turn-1', status: 'completed', error: null } })
    await expect(reply).resolves.toMatchObject({ status: 'done' })
  })

  it('passes PDF text directly to Codex without asking it to run a command', async () => {
    const exec = vi.mocked(childProcess.execFile)
    exec.mockImplementationOnce(((_file: string, _args: string[], _options: unknown, callback: (err: null, stdout: string, stderr: string) => void) => {
      callback(null, 'Sample attachment text', '')
    }) as unknown as typeof childProcess.execFile)
    try {
      const { server, adapter } = setup()
      const { req } = request({ attachments: [
        { name: 'form.pdf', path: '/tmp/attachment folder/form.pdf', size: 40, mediaType: 'application/pdf' },
      ] })
      const reply = adapter.run(req)
      await flush()
      expect(exec).toHaveBeenCalledWith('pdftotext', ['-enc', 'UTF-8', '/tmp/attachment folder/form.pdf', '-'], expect.anything(), expect.any(Function))
      expect(server.requests.find((entry) => entry.method === 'turn/start')!.params.input[0].text).toContain('Sample attachment text')
      server.push('turn/completed', { turn: { id: 'turn-1', status: 'completed', error: null } })
      await expect(reply).resolves.toMatchObject({ status: 'done' })
    } finally {
      exec.mockClear()
    }
  })

  it('starts a read-only thread, streams the reply and finishes with the turn', async () => {
    const { server, adapter } = setup()
    const { req, texts, sessions, models } = request()
    const result = adapter.run(req)
    await flush()

    expect(server.requests.map((r) => r.method)).toEqual(['initialize', 'config/read', 'thread/start', 'turn/start'])
    expect(server.notifications).toEqual(['initialized'])
    expect(server.requests[2]!.params).toEqual({
      cwd: '/tmp/chat',
      sandbox: 'read-only',
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user',
      developerInstructions: 'SYS',
    })
    expect(server.requests[3]!.params.input).toEqual([{ type: 'text', text: '【ユーザー → あなた】\nこんにちは', text_elements: [] }])
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
    expect(server.requests.map((r) => r.method)).toEqual(['initialize', 'config/read', 'thread/resume', 'model/list', 'turn/start', 'turn/start'])
    expect(server.requests[4]!.params).toMatchObject({ effort: 'medium' }) // gpt-6-luna has no xhigh: its own default
    expect(server.requests[2]!.params).toMatchObject({ threadId: 'thread-1', model: 'gpt-6-luna', excludeTurns: true })
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

  it('lists the models and the efforts of the model in use, with the CLI settings as 「自動」', async () => {
    const { server, adapter } = setup()
    await expect(adapter.choices(null)).resolves.toEqual({
      models: [
        { value: 'gpt-6.1-sol', label: 'GPT-6.1 Sol', description: 'Frontier' },
        { value: 'gpt-6-luna', label: 'GPT-6 Luna', description: 'Fast' },
      ],
      defaultModel: 'GPT-6.1 Sol',
      customModel: false,
      efforts: ['low', 'medium', 'high', 'xhigh'],
      defaultEffort: 'xhigh',
    })
    // The configured effort does not exist for this model: its own default is used.
    await expect(adapter.choices('gpt-6-luna')).resolves.toMatchObject({ efforts: ['low', 'medium'], defaultEffort: 'medium' })
    expect(server.requests.filter((r) => r.method === 'model/list')).toHaveLength(1) // read once
  })

  it('takes the configured model as 「自動」', async () => {
    const { server, adapter } = setup()
    server.configuredModel = 'gpt-6-luna'
    await expect(adapter.choices(null)).resolves.toMatchObject({ defaultModel: 'GPT-6 Luna', efforts: ['low', 'medium'] })
  })

  it('switches the model of a thread with the turn, and names the CLI model again for 「自動」', async () => {
    const { server, adapter } = setup()
    const turn = async (model: string | null, sessionId: string | null) => {
      const { req, models } = request({ model, sessionId })
      const done = adapter.run(req)
      await flush()
      await flush()
      server.push('turn/completed', { turn: { id: `turn-${server.requests.filter((r) => r.method === 'turn/start').length}`, status: 'completed', error: null } })
      await done
      return { params: server.requests.filter((r) => r.method === 'turn/start').at(-1)!.params, models }
    }
    expect((await turn(null, null)).params).not.toHaveProperty('model')
    const luna = await turn('gpt-6-luna', 'thread-1')
    expect(luna.params).toMatchObject({ model: 'gpt-6-luna', effort: 'medium' }) // xhigh is not offered by luna
    expect(luna.models).toEqual(['gpt-6-luna'])
    expect((await turn('gpt-6-luna', 'thread-1')).params).not.toHaveProperty('model') // already set
    expect((await turn(null, 'thread-1')).params).toMatchObject({ model: 'gpt-6.1-sol', effort: 'xhigh' })
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

  it('keeps commentary out of the answer and puts it in the work log, as Codex does', async () => {
    const { server, adapter } = setup()
    const tools: ToolLogEntry[] = []
    const { req, texts } = request({ onTool: (tool) => tools.push(tool) })
    const result = adapter.run(req)
    await flush()
    server.push('item/started', { turnId: 'turn-1', item: { type: 'agentMessage', id: 'a', text: '', phase: 'commentary' } })
    server.push('item/agentMessage/delta', { turnId: 'turn-1', itemId: 'a', delta: 'コードを確認します。' })
    server.push('item/completed', { turnId: 'turn-1', item: { type: 'agentMessage', id: 'a', text: 'コードを確認します。', phase: 'commentary' } })
    server.push('item/started', { turnId: 'turn-1', item: { type: 'agentMessage', id: 'b', text: '', phase: 'final_answer' } })
    server.push('item/agentMessage/delta', { turnId: 'turn-1', itemId: 'b', delta: '直しました。' })
    server.push('turn/completed', { turn: { id: 'turn-1', status: 'completed', error: null } })
    await expect(result).resolves.toEqual({ text: '直しました。', status: 'done' })
    expect(texts.join('')).toBe('直しました。')
    expect(tools).toEqual([{ id: 'a', kind: 'note', title: 'コードを確認します。', status: 'done' }])
  })

  it('asks the user the questions Codex asks and sends the answers back', async () => {
    const { server, adapter } = setup()
    const asked: unknown[] = []
    const { req } = request({ askUser: async (questions) => { asked.push(questions); return { scope: ['全部'] } } })
    const result = adapter.run(req)
    await flush()
    await expect(server.onServerRequest('item/tool/requestUserInput', {
      threadId: 'thread-1', turnId: 'turn-1', itemId: 'q', isBlocking: true, autoResolutionMs: null,
      questions: [{ id: 'scope', header: '範囲', question: 'どこまで直しますか', isOther: true, isSecret: false, options: [{ label: '全部', description: 'すべて' }] }],
    })).resolves.toEqual({ answers: { scope: { answers: ['全部'] } } })
    expect(asked).toEqual([[{ id: 'scope', header: '範囲', question: 'どこまで直しますか', options: [{ label: '全部', description: 'すべて' }], multiSelect: false, allowOther: true }]])
    server.push('turn/completed', { turn: { id: 'turn-1', status: 'completed', error: null } })
    await result
  })

  it('steers with images as well as text', async () => {
    const { server, adapter } = setup()
    let steer!: (text: string, attachments?: { name: string; path: string; size: number; mediaType?: 'image/png' }[]) => Promise<boolean>
    const reply = adapter.run(request({ onSteer: (send) => { steer = send } }).req)
    await flush()
    await expect(steer('これも見て', [{ name: 'a.png', path: '/tmp/a.png', size: 3, mediaType: 'image/png' }])).resolves.toBe(true)
    expect(server.requests.at(-1)!.params.input).toEqual([{ type: 'text', text: 'これも見て', text_elements: [] }, { type: 'localImage', path: '/tmp/a.png' }])
    server.push('turn/completed', { turn: { id: 'turn-1', status: 'completed' } })
    await reply
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

describe('Codex in a coding conversation', () => {
  it('updates connector and sandbox permissions when switching out of always-allow', async () => {
    const { server, adapter } = setup()
    server.mcpServers = { notion: { url: 'https://mcp.notion.com/mcp' } }
    const full = adapter.run(request({ cwd: '/work/app', access: 'write', approval: 'auto' }).req)
    await flush()
    await flush()
    expect(server.requests.find((r) => r.method === 'thread/start')!.params).toMatchObject({ sandbox: 'danger-full-access', approvalPolicy: 'never', config: { 'mcp_servers.notion.default_tools_approval_mode': 'approve' } })
    expect(server.requests.find((r) => r.method === 'turn/start')!.params.sandboxPolicy).toEqual({ type: 'dangerFullAccess' })
    server.push('turn/completed', { turn: { id: 'turn-1', status: 'completed', error: null } })
    await full
    const limited = adapter.run(request({ cwd: '/work/app', sessionId: 'thread-1', access: 'read', approval: 'auto' }).req)
    await flush()
    await flush()
    expect(server.requests.find((r) => r.method === 'thread/resume')!.params).toMatchObject({ sandbox: 'read-only', config: { 'mcp_servers.notion.default_tools_approval_mode': 'prompt' } })
    expect(server.requests.filter((r) => r.method === 'turn/start').at(-1)!.params.sandboxPolicy).toEqual({ type: 'readOnly', networkAccess: false })
    server.push('turn/completed', { turn: { id: 'turn-2', status: 'completed', error: null } })
    await limited
    adapter.dispose()
  })

  it('routes auto approvals to Codex review and restores user review for later read/ask turns', async () => {
    const { server, adapter } = setup()
    const auto = adapter.run(request({ cwd: '/work/app', access: 'write', approval: 'auto' }).req)
    await flush()
    await flush()
    expect(server.requests.find((r) => r.method === 'thread/start')!.params).toMatchObject({
      sandbox: 'danger-full-access', approvalPolicy: 'never', approvalsReviewer: 'user',
    })
    expect(server.requests.find((r) => r.method === 'turn/start')!.params).toMatchObject({
      approvalsReviewer: 'user', sandboxPolicy: { type: 'dangerFullAccess' },
    })
    server.push('turn/completed', { turn: { id: 'turn-1', status: 'completed', error: null } })
    await auto
    for (const access of ['read', 'write'] as const) {
      const turn = adapter.run(request({ cwd: '/work/app', sessionId: 'thread-1', access, approval: 'ask' }).req)
      await flush()
      await flush()
      expect(server.requests.filter((r) => r.method === 'turn/start').at(-1)!.params).toMatchObject({
        approvalsReviewer: 'user', sandboxPolicy: { type: access === 'read' ? 'readOnly' : 'workspaceWrite' },
      })
      const turnNumber = server.requests.filter((r) => r.method === 'turn/start').length
      server.push('turn/completed', { turn: { id: `turn-${turnNumber}`, status: 'completed', error: null } })
      await turn
    }
    adapter.dispose()
  })

  /** Starts a write turn in /work/app; returns what it reports and asks. */
  async function writeTurn(answer: 'allow' | 'deny' = 'allow') {
    const { server, adapter } = setup()
    const tools: ToolLogEntry[] = []
    const asked: ApprovalRequest[] = []
    const { req } = request({
      cwd: '/work/app',
      access: 'write',
      approval: 'ask',
      onTool: (tool) => tools.push(tool),
      requestApproval: async (ask) => {
        asked.push(ask)
        return answer
      },
    })
    const done = adapter.run(req)
    await flush()
    await flush()
    return { server, tools, asked, done }
  }

  it('lets the project be changed only on write turns, asking first unless auto', async () => {
    const { server, done } = await writeTurn()
    expect(server.requests.find((r) => r.method === 'thread/start')!.params).toMatchObject({ cwd: '/work/app', sandbox: 'workspace-write', approvalPolicy: 'untrusted' })
    expect(server.requests.find((r) => r.method === 'turn/start')!.params).toMatchObject({
      approvalPolicy: 'untrusted',
      sandboxPolicy: { type: 'workspaceWrite', networkAccess: false },
    })
    server.push('turn/completed', { turn: { id: 'turn-1', status: 'completed', error: null } })
    await done

    const read = setup()
    const reading = read.adapter.run(request({ cwd: '/work/app', access: 'read' }).req)
    await flush()
    await flush()
    expect(read.server.requests.find((r) => r.method === 'turn/start')!.params).toMatchObject({ approvalPolicy: 'on-request', sandboxPolicy: { type: 'readOnly' } })
    read.server.push('turn/completed', { turn: { id: 'turn-1', status: 'completed', error: null } })
    await reading
  })

  it('asks before a command, but not before one that only reads or searches', async () => {
    const { server, asked, done } = await writeTurn('allow')
    const ask = (params: Record<string, unknown>) => server.onServerRequest('item/commandExecution/requestApproval', { threadId: 'thread-1', turnId: 'turn-1', ...params })
    await expect(ask({ itemId: 'c1', command: '/bin/zsh -lc "cat a.ts && rg TODO"', commandActions: [{ type: 'read' }, { type: 'search' }] })).resolves.toEqual({ decision: 'accept' })
    expect(asked).toEqual([])
    await expect(ask({ itemId: 'c2', command: '/bin/zsh -lc "npm test"', commandActions: [{ type: 'unknown' }] })).resolves.toEqual({ decision: 'accept' })
    expect(asked).toEqual([{ kind: 'command', title: 'コマンドを実行: npm test', detail: 'npm test' }])
    server.push('turn/completed', { turn: { id: 'turn-1', status: 'completed', error: null } })
    await done
  })

  it('shows the diff when asking before a file change, and says no when told to', async () => {
    const { server, asked, tools, done } = await writeTurn('deny')
    const change = { type: 'fileChange', id: 'f1', changes: [{ path: '/work/app/src/a.ts', kind: { type: 'update' }, diff: '@@ -1 +1 @@\n-a\n+b' }], status: 'inProgress' }
    server.push('item/started', { turnId: 'turn-1', item: change })
    await expect(server.onServerRequest('item/fileChange/requestApproval', { threadId: 'thread-1', turnId: 'turn-1', itemId: 'f1' })).resolves.toEqual({ decision: 'decline' })
    expect(asked).toEqual([{ kind: 'edit', title: 'ファイルを変更: src/a.ts', detail: '--- src/a.ts\n@@ -1 +1 @@\n-a\n+b' }])
    server.push('item/completed', { turnId: 'turn-1', item: { ...change, status: 'declined' } })
    expect(tools).toEqual([
      { id: 'f1', kind: 'edit', title: 'src/a.ts', status: 'running' },
      { id: 'f1', kind: 'edit', title: 'src/a.ts', status: 'failed' },
    ])
    server.push('turn/completed', { turn: { id: 'turn-1', status: 'completed', error: null } })
    await done
  })

  it('logs commands as the model wrote them', async () => {
    const { server, tools, done } = await writeTurn()
    server.push('item/started', { turnId: 'turn-1', item: { type: 'commandExecution', id: 'c1', command: '/bin/zsh -lc "npm test"', commandActions: [{ type: 'unknown' }], status: 'inProgress' } })
    server.push('item/completed', { turnId: 'turn-1', item: { type: 'commandExecution', id: 'c1', command: '/bin/zsh -lc "npm test"', commandActions: [{ type: 'unknown' }], status: 'completed', exitCode: 1 } })
    server.push('item/started', { turnId: 'turn-1', item: { type: 'commandExecution', id: 'c2', command: "/bin/zsh -lc 'cat README.md'", commandActions: [{ type: 'read' }], status: 'inProgress' } })
    expect(tools).toEqual([
      { id: 'c1', kind: 'command', title: 'npm test', status: 'running' },
      { id: 'c1', kind: 'command', title: 'npm test', status: 'failed' },
      { id: 'c2', kind: 'read', title: 'cat README.md', status: 'running' },
    ])
    expect(unwrapShell('/bin/bash -lc "echo \\"hi\\""')).toBe('echo "hi"')
    expect(unwrapShell('ls -la')).toBe('ls -la')
    server.push('turn/completed', { turn: { id: 'turn-1', status: 'completed', error: null } })
    await done
  })

  it('refuses approval requests when no turn is running on the thread', async () => {
    const { server, adapter } = setup()
    const done = adapter.run(request({ cwd: '/work/app', access: 'write' }).req)
    await flush()
    await flush()
    server.push('turn/completed', { turn: { id: 'turn-1', status: 'completed', error: null } })
    await done
    await expect(server.onServerRequest('item/commandExecution/requestApproval', { threadId: 'thread-1', itemId: 'x' })).rejects.toThrow()
  })
})

describe('Codex with connectors (Notion, …)', () => {
  async function turn(answer: 'allow' | 'deny' = 'allow', access: AgentRunRequest['access'] = 'chat', notion: unknown = { url: 'https://mcp.notion.com/mcp' }) {
    const { server, adapter } = setup()
    server.mcpServers = { notion }
    const asked: ApprovalRequest[] = []
    const tools: ToolLogEntry[] = []
    const { req } = request({
      access,
      ...(access === 'chat' ? {} : { cwd: '/work/app' }),
      onTool: (tool) => tools.push(tool),
      requestApproval: async (ask) => {
        asked.push(ask)
        return answer
      },
    })
    const done = adapter.run(req)
    await flush()
    await flush()
    const elicit = (tool: string, readOnly: boolean) =>
      server.onServerRequest('mcpServer/elicitation/request', {
        threadId: 'thread-1',
        serverName: 'notion',
        _meta: { codex_approval_kind: 'mcp_tool_call', tool_name: tool, tool_title: tool, tool_annotations: { readOnlyHint: readOnly }, tool_params: { title: '応募先' } },
      })
    return { server, asked, tools, done, elicit }
  }

  it('sets every connector to ask first', async () => {
    const { server, done } = await turn()
    expect(server.requests.find((r) => r.method === 'thread/start')!.params.config).toEqual({ 'mcp_servers.notion.default_tools_approval_mode': 'prompt' })
    server.push('turn/completed', { turn: { id: 'turn-1', status: 'completed', error: null } })
    await done
  })

  it('lets reads through, asks before the rest, and logs the calls', async () => {
    const { server, asked, tools, done, elicit } = await turn('allow')
    await expect(elicit('notion-search', true)).resolves.toEqual({ action: 'accept', content: {} })
    await expect(elicit('notion-create-pages', false)).resolves.toEqual({ action: 'accept', content: {} })
    expect(asked).toEqual([{ kind: 'other', title: 'notion を操作: notion-create-pages', detail: '{\n  "title": "応募先"\n}' }])
    server.push('item/started', { turnId: 'turn-1', item: { type: 'mcpToolCall', id: 'm1', server: 'notion', tool: 'notion-search', status: 'inProgress' } })
    expect(tools).toEqual([{ id: 'm1', kind: 'search', title: 'notion: notion-search', status: 'running' }])
    server.push('turn/completed', { turn: { id: 'turn-1', status: 'completed', error: null } })
    await done
  })

  it('on a read-only turn, lets only verified reads through and refuses the rest without asking', async () => {
    const { server, asked, done, elicit } = await turn('allow', 'read')
    await expect(elicit('notion-search', true)).resolves.toEqual({ action: 'accept', content: {} })
    // The server's own read-only hint is not enough, and a change is never asked about.
    await expect(elicit('notion-get-and-archive', true)).resolves.toEqual({ action: 'decline' })
    await expect(elicit('notion-create-pages', false)).resolves.toEqual({ action: 'decline' })
    expect(asked).toEqual([])
    server.push('turn/completed', { turn: { id: 'turn-1', status: 'completed', error: null } })
    await done
  })
  it('on a read-only turn, refuses a server that takes a known name at another URL', async () => {
    const { server, asked, done, elicit } = await turn('allow', 'read', { url: 'https://evil.example/mcp' })
    await expect(elicit('notion-search', true)).resolves.toEqual({ action: 'decline' })
    expect(asked).toEqual([])
    server.push('turn/completed', { turn: { id: 'turn-1', status: 'completed', error: null } })
    await done
  })
})

