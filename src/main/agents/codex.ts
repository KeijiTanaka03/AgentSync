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

/**
 * Talks to one long-running `codex app-server` process.
 * Each conversation is a Codex thread; each reply is one turn.
 */
export class CodexAdapter implements AgentAdapter {
  readonly id = 'gpt' as const
  private connection: Promise<RpcConnection> | null = null
  private readonly loadedThreads = new Set<string>()
  private readonly threadListeners = new Map<string, ThreadListener>()

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
      request.onSession(threadId)
      request.onModel(started.model)
    } else if (!this.loadedThreads.has(threadId)) {
      const resumed = await rpc.request<ThreadResponse>('thread/resume', { threadId, ...threadSettings, excludeTurns: true })
      this.loadedThreads.add(threadId)
      request.onModel(resumed.model)
    }

    return this.runTurn(rpc, threadId, request)
  }

  dispose(): void {
    const connection = this.connection
    this.connection = null
    this.loadedThreads.clear()
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
      this.loadedThreads.clear()
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

  private runTurn(rpc: RpcConnection, threadId: string, request: AgentRunRequest): Promise<AgentRunResult> {
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
          case 'item/completed': {
            const item = params.item as Json | undefined
            if (item?.type === 'agentMessage' && typeof item.id === 'string' && typeof item.text === 'string') {
              items.set(item.id, item.text)
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
        })
        .then((started) => {
          turnId = started.turn.id
          if (request.signal.aborted) interrupt()
        })
        .catch((error: unknown) => {
          finish()
          reject(error instanceof Error ? error : new Error(String(error)))
        })
    })
  }
}
