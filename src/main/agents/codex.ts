import type { AgentActivity, AgentChoices } from '../../shared/types'
import type { AgentAdapter, AgentRunRequest, AgentRunResult } from './types'
import type { RpcConnection } from './jsonRpc'

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
  config: { model?: string | null; model_reasoning_effort?: string | null }
}

/** What the user's Codex configuration sets, if anything. */
interface CodexConfig {
  model: string | null
  effort: string | null
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
  private readonly threadListeners = new Map<string, ThreadListener>()
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

    // Chat mode: Codex may read nothing outside an empty folder and never asks for approval.
    const threadSettings = {
      cwd: request.cwd,
      sandbox: 'read-only',
      approvalPolicy: 'never',
      developerInstructions: request.systemPrompt,
      ...(request.model ? { model: request.model } : {}),
    }

    let threadId = request.sessionId
    if (!threadId) {
      const started = await rpc.request<ThreadResponse>('thread/start', threadSettings)
      threadId = started.thread.id
      this.loadedThreads.add(threadId)
      this.threadSettings.set(threadId, { model: request.model, effort: null })
      request.onSession(threadId)
      request.onModel(started.model)
    } else if (!this.loadedThreads.has(threadId)) {
      const resumed = await rpc.request<ThreadResponse>('thread/resume', { threadId, ...threadSettings, excludeTurns: true })
      this.loadedThreads.add(threadId)
      request.onModel(resumed.model)
    }

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
      .then((response) => ({ model: response.config.model ?? null, effort: response.config.model_reasoning_effort ?? null }))
      .catch(() => ({ model: null, effort: null }))
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
        request.signal.removeEventListener('abort', interrupt)
      }

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
            return
          }
          case 'item/completed': {
            const item = params.item as Json | undefined
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
