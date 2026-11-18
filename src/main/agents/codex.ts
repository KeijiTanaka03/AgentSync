import path from 'node:path'
import type { AgentActivity, AgentChoices, ApprovalMode, ToolLogEntry } from '../../shared/types'
import type { Access, AgentAdapter, AgentRunRequest, AgentRunResult, ApprovalRequest } from './types'
import { RpcError, type RpcConnection } from './jsonRpc'

// The subset of the `codex app-server` protocol this adapter uses.
// Generated reference: `codex app-server generate-ts --out <dir>`.

interface ThreadResponse {
  thread: { id: string }
  model: string
}

interface TurnStartResponse {
  turn: { id: string }
}

interface CodexModel {
  model: string
  displayName?: string
  description?: string
  hidden?: boolean
  isDefault: boolean
  supportedReasoningEfforts: { reasoningEffort: string }[]
  defaultReasoningEffort: string
}

interface ModelListResponse {
  data: CodexModel[]
  nextCursor: string | null
}

interface ConfigReadResponse {
  config: { model?: string | null; model_reasoning_effort?: string | null; mcp_servers?: Record<string, unknown> | null }
}

/** What the user's Codex configuration sets, if anything. */
interface CodexConfig {
  model: string | null
  effort: string | null
  /** Names of the connectors (MCP servers) set up in Codex. */
  mcpServers: string[]
}

/** Every connector asks before each tool call, so AgentSync can decide (see the approval handler). */
export function connectorOverrides(servers: readonly string[], always = false): Record<string, string> {
  return Object.fromEntries(servers.filter((name) => /^[\w-]+$/.test(name)).map((name) => [`mcp_servers.${name}.default_tools_approval_mode`, always ? 'approve' : 'prompt']))
}

/** The model and effort a thread runs at. Null: the CLI's own setting. */
interface ThreadSettings {
  model: string | null
  effort: string | null
}

/** What to send with a turn so that the thread runs at the chosen settings. */
interface TurnOverrides {
  model?: string
  effort?: string
  /** False when the CLI's own setting could not be named; the thread's settings are then still unknown. */
  complete: boolean
}

interface TurnCompletedParams {
  threadId: string
  turn: { id: string; status: 'completed' | 'interrupted' | 'failed' | 'inProgress'; error: { message: string } | null }
}

type Json = Record<string, unknown>

export interface CodexAdapterOptions {
  /** Starts `codex app-server` and returns the connection (not yet initialized). */
  connect(): Promise<RpcConnection>
  clientVersion: string
}

/** A listener for notifications that belong to one thread. */
type ThreadListener = (method: string, params: Json) => void

/** Answers the approval requests of the turn running on a thread. */
type ApprovalHandler = (method: string, params: Json) => Promise<unknown>

const MAX_TITLE = 200
const MAX_DETAIL = 4_000

/** How a Codex thread may touch the project for an access level. */
export function codexPolicy(access: Access, approval: ApprovalMode) {
  if (access !== 'write') {
    // 「on-request」, not 「never」: with 「never」 Codex refuses connector calls set to ask first by itself.
    return { sandbox: 'read-only', approvalPolicy: 'on-request', approvalsReviewer: 'user', sandboxPolicy: { type: 'readOnly', networkAccess: false } }
  }
  if (approval === 'auto') return { sandbox: 'danger-full-access', approvalPolicy: 'never', approvalsReviewer: 'user', sandboxPolicy: { type: 'dangerFullAccess' } }
  return {
    sandbox: 'workspace-write',
    // 「untrusted」 asks before every command that is not plainly safe and before every file change;
    approvalPolicy: 'untrusted',
    approvalsReviewer: 'user',
    sandboxPolicy: { type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
  }
}

/** `/bin/zsh -lc "ls -la"` → `ls -la`: the command as the model wrote it. */
export function unwrapShell(command: string): string {
  const match = /^\S*\/(?:ba|z)?sh -l?c (['"])([\s\S]*)\1$/.exec(command.trim())
  return match ? match[2]!.replace(/\\(["\\])/g, '$1') : command
}

function oneLine(text: string): string {
  const line = text.split('\n').find((l) => l.trim() !== '') ?? ''
  return line.length > MAX_TITLE ? `${line.slice(0, MAX_TITLE)}…` : line
}

const clip = (text: string) => (text.length > MAX_DETAIL ? `${text.slice(0, MAX_DETAIL)}\n…` : text)

function relativeTo(cwd: string, file: unknown): string {
  const text = typeof file === 'string' ? file : ''
  const relative = path.isAbsolute(text) ? path.relative(cwd, text) : text
  return relative && !relative.startsWith('..') ? relative : text
}

/** How a Codex turn item is shown in the work log (null for messages and reasoning). */
export function describeCodexItem(item: Json, cwd: string): Pick<ToolLogEntry, 'kind' | 'title'> | null {
  switch (item.type) {
    case 'commandExecution': {
      const actions = Array.isArray(item.commandActions) ? (item.commandActions as Json[]) : []
      const kinds = new Set(actions.map((a) => a.type))
      const kind = kinds.size === 1 && kinds.has('read') ? 'read' : kinds.size === 1 && kinds.has('search') ? 'search' : kinds.size === 1 && kinds.has('listFiles') ? 'list' : 'command'
      return { kind, title: oneLine(unwrapShell(String(item.command ?? ''))) }
    }
    case 'fileChange': {
      const changes = Array.isArray(item.changes) ? (item.changes as Json[]) : []
      return { kind: 'edit', title: changes.map((c) => relativeTo(cwd, c.path)).join(', ') }
    }
    case 'webSearch':
      return { kind: 'web', title: oneLine(String(item.query ?? '')) || 'ウェブ検索' }
    case 'mcpToolCall':
    case 'dynamicToolCall': {
      const tool = String(item.tool ?? item.type)
      return { kind: /search|query/i.test(tool) ? 'search' : 'other', title: item.server ? `${String(item.server)}: ${tool}` : tool }
    }
    default:
      return null
  }
}

function toolStatus(item: Json, finished: boolean): ToolLogEntry['status'] {
  if (!finished) return 'running'
  if (item.status === 'failed' || item.status === 'declined') return 'failed'
  if (typeof item.exitCode === 'number' && item.exitCode !== 0) return 'failed'
  return 'done'
}

/** Commands that only read, list or search (as Codex parses them) are allowed without asking. */
function onlyReads(params: Json): boolean {
  const actions = Array.isArray(params.commandActions) ? (params.commandActions as Json[]) : []
  return actions.length > 0 && actions.every((a) => a.type === 'read' || a.type === 'listFiles' || a.type === 'search')
}

/** Items in which Codex does something other than think or write (run a command, call a tool, …). */
const WORKING_ITEMS = new Set([
  'commandExecution',
  'fileChange',
  'mcpToolCall',
  'dynamicToolCall',
  'collabAgentToolCall',
  'subAgentActivity',
  'imageView',
  'imageGeneration',
  'contextCompaction',
])

/** What a new turn item means for the activity shown in the chat. Messages are reported as text. */
function itemActivity(item: Json): AgentActivity | null {
  if (item.type === 'reasoning' || item.type === 'plan') return { kind: 'thinking' }
  if (item.type === 'webSearch') {
    const query = typeof item.query === 'string' ? item.query.trim() : ''
    return query ? { kind: 'searching', detail: query } : { kind: 'searching' }
  }
  if (typeof item.type === 'string' && WORKING_ITEMS.has(item.type)) return { kind: 'working' }
  return null
}

/**
 * What 「自動」 means for a model: the configured or default model, and the effort the configuration sets
 * if that model accepts it (otherwise the model's own default).
 */
function resolveDefaults(
  models: CodexModel[],
  config: CodexConfig,
  model: string | null,
): { model: string | null; effort: string | null; efforts: string[] } {
  const defaultModel = config.model ?? models.find((m) => m.isDefault)?.model ?? null
  const entry = models.find((m) => m.model === (model ?? defaultModel)) ?? models.find((m) => m.isDefault) ?? models[0]
  const efforts = entry ? entry.supportedReasoningEfforts.map((e) => e.reasoningEffort) : []
  const effort =
    config.effort && (efforts.length === 0 || efforts.includes(config.effort)) ? config.effort : (entry?.defaultReasoningEffort ?? null)
  return { model: defaultModel, effort, efforts }
}

/**
 * Talks to one long-running `codex app-server` process.
 * Each conversation is a Codex thread; each reply is one turn.
 */
export class CodexAdapter implements AgentAdapter {
  readonly id = 'gpt' as const
  private connection: Promise<RpcConnection> | null = null
  private readonly loadedThreads = new Set<string>()
  private readonly threadAlways = new Map<string, boolean>()
  private readonly threadListeners = new Map<string, ThreadListener>()
  private readonly approvalHandlers = new Map<string, ApprovalHandler>()
  /**
   * The model and effort each loaded thread runs at, as last set in this process. Codex keeps a model or
   * effort given with a turn for the later turns too. A thread resumed from an earlier run is not listed: unknown.
   */
  private readonly threadSettings = new Map<string, ThreadSettings>()
  /** Read once per app-server process. */
  private models: Promise<CodexModel[]> | null = null
  private config: Promise<CodexConfig> | null = null

  constructor(private readonly options: CodexAdapterOptions) {}

  async run(request: AgentRunRequest): Promise<AgentRunResult> {
    const rpc = await this.connect()
    if (request.signal.aborted) return { text: '', status: 'stopped' }

    // Chat: read-only in an empty folder, never asking. Coding: the project folder, as the access allows.
    const policy = codexPolicy(request.access, request.approval)
    const { mcpServers } = await this.readConfig(rpc)
    const always = request.access === 'write' && request.approval === 'auto'
    const threadSettings = {
      cwd: request.cwd,
      sandbox: policy.sandbox,
      approvalPolicy: policy.approvalPolicy,
      approvalsReviewer: policy.approvalsReviewer,
      developerInstructions: request.systemPrompt,
      ...(request.model ? { model: request.model } : {}),
      ...(mcpServers.length > 0 ? { config: connectorOverrides(mcpServers, always) } : {}),
    }

    let threadId = request.sessionId
    if (!threadId) {
      const started = await rpc.request<ThreadResponse>('thread/start', threadSettings)
      threadId = started.thread.id
      this.loadedThreads.add(threadId)
      this.threadSettings.set(threadId, { model: request.model, effort: null })
      request.onSession(threadId)
      request.onModel(started.model)
    } else if (!this.loadedThreads.has(threadId) || this.threadAlways.get(threadId) !== always) {
      const resumed = await rpc.request<ThreadResponse>('thread/resume', { threadId, ...threadSettings, excludeTurns: true })
      this.loadedThreads.add(threadId)
      request.onModel(resumed.model)
    }

    this.threadAlways.set(threadId, always)
    const overrides = await this.turnOverrides(threadId, request)
    return this.runTurn(rpc, threadId, request, overrides)
  }

  async choices(model: string | null): Promise<AgentChoices> {
    const rpc = await this.connect()
    const [models, config] = await Promise.all([this.listModels(rpc), this.readConfig(rpc)])
    const defaults = resolveDefaults(models, config, model)
    const defaultEntry = models.find((m) => m.model === defaults.model)
    return {
      models: models
        .filter((m) => !m.hidden)
        .map((m) => ({ value: m.model, label: m.displayName || m.model, description: m.description || null })),
      defaultModel: defaultEntry ? defaultEntry.displayName || defaultEntry.model : defaults.model,
      customModel: false,
      efforts: defaults.efforts,
      defaultEffort: defaults.effort,
    }
  }

  /** The plan's usage limits (`account/rateLimits/read`; uses none of them). */
  async rateLimits(): Promise<unknown> {
    const rpc = await this.connect()
    return rpc.request('account/rateLimits/read', {})
  }

  dispose(): void {
    const connection = this.connection
    this.connection = null
    this.forgetProcess()
    void connection?.then((rpc) => rpc.dispose()).catch(() => {})
  }

  private connect(): Promise<RpcConnection> {
    if (!this.connection) {
      this.connection = this.open().catch((error: unknown) => {
        this.connection = null
        throw error
      })
    }
    return this.connection
  }

  private async open(): Promise<RpcConnection> {
    const rpc = await this.options.connect()
    rpc.onNotification = (method, params) => {
      if (typeof params !== 'object' || params === null) return
      const threadId = (params as Json).threadId
      if (typeof threadId === 'string') this.threadListeners.get(threadId)?.(method, params as Json)
    }
    // Approval requests go to the turn running on their thread; with none running, the answer is no.
    rpc.onServerRequest = async (method, params) => {
      const threadId = typeof params === 'object' && params !== null ? (params as Json).threadId : null
      const handler = typeof threadId === 'string' ? this.approvalHandlers.get(threadId) : undefined
      if (!handler) throw new RpcError(-32601, `AgentSync はこの要求に対応していません: ${method}`)
      return handler(method, params as Json)
    }
    rpc.onClose = (error) => {
      this.connection = null
      this.forgetProcess()
      for (const listener of this.threadListeners.values()) listener('agentsync/closed', { message: error.message })
    }
    try {
      await rpc.request('initialize', {
        clientInfo: { name: 'agentsync', title: 'AgentSync', version: this.options.clientVersion },
        capabilities: { experimentalApi: false, requestAttestation: false },
      })
      rpc.notify('initialized')
    } catch (error) {
      rpc.dispose()
      throw new Error(`Codex CLI に接続できませんでした: ${error instanceof Error ? error.message : String(error)}`)
    }
    return rpc
  }

  /** What a new app-server process will not know: loaded threads and what was read from Codex. */
  private forgetProcess(): void {
    this.loadedThreads.clear()
    this.threadAlways.clear()
    this.threadSettings.clear()
    this.models = null
    this.config = null
  }

  private listModels(rpc: RpcConnection): Promise<CodexModel[]> {
    this.models ??= (async () => {
      const models: CodexModel[] = []
      let cursor: string | null = null
      for (let page = 0; page < 10; page++) {
        const response: ModelListResponse = await rpc.request<ModelListResponse>('model/list', cursor ? { cursor } : {})
        models.push(...response.data)
        cursor = response.nextCursor
        if (!cursor) break
      }
      return models
    })().catch((error: unknown) => {
      this.models = null
      throw error
    })
    return this.models
  }

  /** `model` and `model_reasoning_effort` from the user's Codex configuration, if set. */
  private readConfig(rpc: RpcConnection): Promise<CodexConfig> {
    this.config ??= rpc
      .request<ConfigReadResponse>('config/read', {})
      .then((response) => ({
        model: response.config.model ?? null,
        effort: response.config.model_reasoning_effort ?? null,
        mcpServers: Object.keys(response.config.mcp_servers ?? {}),
      }))
      .catch(() => ({ model: null, effort: null, mcpServers: [] }))
    return this.config
  }

  /**
   * What to send with this turn. Nothing when the thread already runs at the chosen settings. Otherwise
   * both are named, including the CLI's own setting for 「自動」, since Codex would keep an earlier choice.
   */
  private async turnOverrides(threadId: string, request: AgentRunRequest): Promise<TurnOverrides> {
    const current = this.threadSettings.get(threadId)
    if (current && current.model === request.model && current.effort === request.effort) return { complete: true }
    let defaults: { model: string | null; effort: string | null } = { model: null, effort: null }
    if (!request.model || !request.effort) {
      try {
        const rpc = await this.connect()
        const [models, config] = await Promise.all([this.listModels(rpc), this.readConfig(rpc)])
        defaults = resolveDefaults(models, config, request.model)
      } catch {
        // Send what is known; the thread's settings stay unknown and are named again next time.
      }
    }
    const model = request.model ?? defaults.model
    const effort = request.effort ?? defaults.effort
    return { ...(model ? { model } : {}), ...(effort ? { effort } : {}), complete: model !== null && effort !== null }
  }

  private runTurn(rpc: RpcConnection, threadId: string, request: AgentRunRequest, overrides: TurnOverrides): Promise<AgentRunResult> {
    const policy = codexPolicy(request.access, request.approval)
    return new Promise<AgentRunResult>((resolve, reject) => {
      let turnId: string | null = null
      let lastItemId: string | null = null
      let lastError: string | null = null
      // Agent message items in arrival order; a turn may contain more than one.
      const items = new Map<string, string>()
      const fullText = () => [...items.values()].filter((t) => t !== '').join('\n\n')

      const interrupt = () => {
        if (turnId) void rpc.request('turn/interrupt', { threadId, turnId }).catch(() => {})
      }
      const finish = () => {
        this.threadListeners.delete(threadId)
        this.approvalHandlers.delete(threadId)
        request.signal.removeEventListener('abort', interrupt)
      }

      // File changes arrive as items first; their approval request only names the item.
      const fileChanges = new Map<string, Json>()
      const report = (item: Json, finished: boolean) => {
        if (typeof item.id !== 'string') return
        const described = describeCodexItem(item, request.cwd)
        if (described) request.onTool({ id: item.id, ...described, status: toolStatus(item, finished) })
      }
      this.approvalHandlers.set(threadId, async (method, params) => {
        let ask: ApprovalRequest | null = null
        if (method === 'mcpServer/elicitation/request') {
          // A connector's tool call (with every connector set to ask first). Reading goes ahead.
          const meta = (typeof params._meta === 'object' && params._meta !== null ? params._meta : {}) as Json
          if (meta.codex_approval_kind !== 'mcp_tool_call') return { action: 'decline' }
          const annotations = (typeof meta.tool_annotations === 'object' && meta.tool_annotations !== null ? meta.tool_annotations : {}) as Json
          if (annotations.readOnlyHint === true) return { action: 'accept', content: {} }
          const tool = String(meta.tool_title ?? meta.tool_name ?? '')
          const answer = await request.requestApproval({
            kind: 'other',
            title: `${String(params.serverName ?? '連携')} を操作: ${tool}`,
            detail: meta.tool_params === undefined ? null : clip(JSON.stringify(meta.tool_params, null, 2)),
          })
          return answer === 'allow' ? { action: 'accept', content: {} } : { action: 'decline' }
        }
        if (method === 'item/commandExecution/requestApproval') {
          if (onlyReads(params)) return { decision: 'accept' }
          const command = unwrapShell(String(params.command ?? ''))
          ask = { kind: 'command', title: `コマンドを実行: ${oneLine(command)}`, detail: clip(command) }
        } else if (method === 'item/fileChange/requestApproval') {
          const item = fileChanges.get(String(params.itemId)) ?? {}
          const changes = Array.isArray(item.changes) ? (item.changes as Json[]) : []
          const files = changes.map((c) => relativeTo(request.cwd, c.path)).join(', ')
          const diff = changes.map((c) => `--- ${relativeTo(request.cwd, c.path)}\n${String(c.diff ?? '')}`).join('\n')
          ask = { kind: 'edit', title: `ファイルを変更: ${files || '（不明）'}`, detail: diff ? clip(diff) : null }
        }
        if (!ask) throw new RpcError(-32601, `AgentSync はこの要求に対応していません: ${method}`)
        const decision = await request.requestApproval(ask)
        return { decision: decision === 'allow' ? 'accept' : 'decline' }
      })

      this.threadListeners.set(threadId, (method, params) => {
        const paramTurnId = typeof params.turnId === 'string' ? params.turnId : null
        if (turnId && paramTurnId && paramTurnId !== turnId) return

        switch (method) {
          case 'item/agentMessage/delta': {
            const itemId = String(params.itemId)
            const delta = typeof params.delta === 'string' ? params.delta : ''
            if (!delta) return
            const separator = lastItemId !== null && lastItemId !== itemId && fullText() !== '' ? '\n\n' : ''
            lastItemId = itemId
            items.set(itemId, (items.get(itemId) ?? '') + delta)
            request.onText(separator + delta)
            return
          }
          case 'item/started': {
            const item = params.item as Json | undefined
            const activity = item ? itemActivity(item) : null
            if (activity) request.onActivity(activity)
            if (item?.type === 'fileChange' && typeof item.id === 'string') fileChanges.set(item.id, item)
            if (item) report(item, false)
            return
          }
          case 'item/completed': {
            const item = params.item as Json | undefined
            if (item) report(item, true)
            if (item?.type === 'agentMessage' && typeof item.id === 'string' && typeof item.text === 'string') {
              items.set(item.id, item.text)
            } else if (item) {
              // A search or tool call has finished; Codex thinks about the result next.
              const finished = itemActivity(item)
              if (finished && finished.kind !== 'thinking') request.onActivity({ kind: 'thinking' })
            }
            return
          }
          case 'error': {
            const error = params.error as Json | undefined
            if (params.willRetry !== true && typeof error?.message === 'string') lastError = error.message
            return
          }
          case 'turn/completed': {
            const { turn } = params as unknown as TurnCompletedParams
            if (turnId && turn.id !== turnId) return
            finish()
            if (turn.status === 'completed') resolve({ text: fullText(), status: 'done' })
            else if (turn.status === 'interrupted') resolve({ text: fullText(), status: 'stopped' })
            else reject(new Error(turn.error?.message ?? lastError ?? 'GPT の応答に失敗しました'))
            return
          }
          case 'agentsync/closed': {
            finish()
            if (request.signal.aborted) resolve({ text: fullText(), status: 'stopped' })
            else reject(new Error(`Codex CLI との接続が切れました: ${String(params.message)}`))
            return
          }
        }
      })

      request.signal.addEventListener('abort', interrupt, { once: true })
      rpc
        .request<TurnStartResponse>('turn/start', {
          threadId,
          input: [{ type: 'text', text: request.prompt, text_elements: [] }],
          // A coding thread changes between reading and writing from turn to turn.
          ...(request.access === 'chat'
            ? {}
            : { approvalPolicy: policy.approvalPolicy, approvalsReviewer: policy.approvalsReviewer, sandboxPolicy: policy.sandboxPolicy }),
          ...(overrides.model ? { model: overrides.model } : {}),
          ...(overrides.effort ? { effort: overrides.effort } : {}),
        })
        .then((started) => {
          turnId = started.turn.id
          // The thread now runs at the chosen settings (null: the CLI's own ones).
          if (overrides.complete) this.threadSettings.set(threadId, { model: request.model, effort: request.effort })
          if (overrides.model) request.onModel(overrides.model)
          if (request.signal.aborted) interrupt()
        })
        .catch((error: unknown) => {
          finish()
          reject(error instanceof Error ? error : new Error(String(error)))
        })
    })
  }
}
