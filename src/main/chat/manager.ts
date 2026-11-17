import { randomBytes } from 'node:crypto'
import {
  AGENT_IDS,
  DEFAULT_TITLE,
  type AgentChoices,
  type AgentId,
  type ChatSnapshot,
  type ConversationEventEnvelope,
  type ConversationSummary,
  type SendRequest,
} from '../../shared/types'
import type { AgentAdapter } from '../agents/types'
import type { ConversationData, ConversationStore } from '../store/conversationStore'
import { Orchestrator } from './orchestrator'

export interface ChatManagerOptions {
  store: ConversationStore
  /** Shared by every conversation. Disposed with the manager. */
  adapters: Record<AgentId, AgentAdapter>
  /** Working directory for chat-mode CLI sessions (an empty folder). */
  cwd: string
  emitEvent(envelope: ConversationEventEnvelope): void
  emitConversations(conversations: ConversationSummary[]): void
  /** Models for new conversations. */
  models?: Partial<Record<AgentId, string | null>>
  /** Reasoning efforts for new conversations (the last ones chosen). */
  efforts?: Partial<Record<AgentId, string | null>>
  /** Called when a different effort is chosen, so it can be kept for new conversations. */
  onEffortsChange?(efforts: Record<AgentId, string | null>): void
  now?: () => Date
  /** How long to wait after a change before writing the file. */
  saveDelayMs?: number
  newId?: () => string
}

interface Entry {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  /** Loaded when the conversation is first opened. */
  orchestrator: Orchestrator | null
  saveTimer: ReturnType<typeof setTimeout> | null
}

const defaultId = () => `${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`

/**
 * Keeps every conversation: the list for the sidebar, the open ones in memory,
 * and their files on disk. A new conversation is written only once it has content.
 */
export class ChatManager {
  private readonly entries = new Map<string, Entry>()
  private readonly now: () => Date
  private readonly newId: () => string
  private readonly efforts: Record<AgentId, string | null>

  constructor(private readonly options: ChatManagerOptions) {
    this.now = options.now ?? (() => new Date())
    this.newId = options.newId ?? defaultId
    this.efforts = Object.fromEntries(AGENT_IDS.map((id) => [id, options.efforts?.[id] ?? null])) as Record<AgentId, string | null>
    for (const data of options.store.list()) {
      this.entries.set(data.id, {
        id: data.id,
        title: data.title,
        createdAt: data.createdAt,
        updatedAt: data.updatedAt,
        orchestrator: null,
        saveTimer: null,
      })
    }
  }

  list(): ConversationSummary[] {
    return [...this.entries.values()]
      .map((entry) => ({
        id: entry.id,
        title: entry.title,
        updatedAt: entry.updatedAt,
        busy: entry.orchestrator?.busy ?? false,
        dialogue: entry.orchestrator?.inDialogue ?? false,
      }))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  /** Opens a new, empty conversation. An empty one that is already open is reused. */
  create(): string {
    for (const entry of this.entries.values()) {
      if (entry.orchestrator?.isEmpty && entry.title === DEFAULT_TITLE) {
        // It may have been opened before another effort was chosen elsewhere.
        for (const agent of AGENT_IDS) entry.orchestrator.setEffort(agent, this.efforts[agent])
        entry.updatedAt = this.now().toISOString()
        this.publishList()
        return entry.id
      }
    }
    let id = this.newId()
    while (this.entries.has(id)) id = this.newId()
    const at = this.now().toISOString()
    const entry: Entry = { id, title: DEFAULT_TITLE, createdAt: at, updatedAt: at, orchestrator: null, saveTimer: null }
    entry.orchestrator = this.createOrchestrator(entry)
    this.entries.set(id, entry)
    this.publishList()
    return id
  }

  rename(id: string, title: string): void {
    this.orchestrator(id).setTitle(title)
  }

  /** Chooses an agent's effort in one conversation; new conversations start with it too. */
  setEffort(id: string, agent: AgentId, effort: string | null): void {
    this.orchestrator(id).setEffort(agent, effort)
    if (this.efforts[agent] === effort) return
    this.efforts[agent] = effort
    this.options.onEffortsChange?.({ ...this.efforts })
  }

  agentChoices(id: string, agent: AgentId): Promise<AgentChoices> {
    return this.orchestrator(id).choices(agent)
  }

  /** Stops the conversation and deletes its file. The CLIs keep their own history. */
  delete(id: string): void {
    const entry = this.entries.get(id)
    if (!entry) return
    this.entries.delete(id)
    if (entry.saveTimer) clearTimeout(entry.saveTimer)
    entry.saveTimer = null
    entry.orchestrator?.stop()
    this.options.store.remove(id)
    this.publishList()
  }

  has(id: string): boolean {
    return this.entries.has(id)
  }

  snapshot(id: string): ChatSnapshot {
    return this.orchestrator(id).snapshot()
  }

  send(id: string, request: SendRequest): void {
    this.orchestrator(id).send(request)
  }

  stop(id: string): void {
    this.entries.get(id)?.orchestrator?.stop()
  }

  setDialogue(id: string, on: boolean): void {
    this.orchestrator(id).setDialogue(on)
  }

  stopAll(): void {
    for (const entry of this.entries.values()) entry.orchestrator?.stop()
  }

  /**
   * Writes pending changes now. With `everything`, also writes conversations whose reply is
   * still streaming, so the text so far is kept (it is shown as stopped next time).
   */
  flush(everything = false): void {
    for (const entry of this.entries.values()) {
      if (!entry.saveTimer && !(everything && entry.orchestrator?.busy)) continue
      if (entry.saveTimer) clearTimeout(entry.saveTimer)
      entry.saveTimer = null
      this.save(entry)
    }
  }

  /**
   * For quitting: stops the replies (a dialogue says it ended), writes everything including the text
   * received so far, then closes the CLIs.
   */
  dispose(): void {
    this.stopAll()
    this.flush(true)
    for (const adapter of Object.values(this.options.adapters)) adapter.dispose()
  }

  private orchestrator(id: string): Orchestrator {
    const entry = this.entries.get(id)
    if (!entry) throw new Error('会話が見つかりません')
    if (!entry.orchestrator) {
      let data: ConversationData
      try {
        data = this.options.store.load(id)
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        throw new Error(`会話を読み込めませんでした: ${reason}`)
      }
      entry.orchestrator = this.createOrchestrator(entry, data)
    }
    return entry.orchestrator
  }

  private createOrchestrator(entry: Entry, data?: ConversationData): Orchestrator {
    return new Orchestrator({
      adapters: this.options.adapters,
      cwd: this.options.cwd,
      models: this.options.models,
      efforts: { ...this.efforts },
      now: this.now,
      ...(data ? { initial: data } : {}),
      emit: (envelope) => {
        // A deleted conversation may still finish a reply; drop what it says.
        if (this.entries.get(entry.id) !== entry) return
        this.options.emitEvent({ conversationId: entry.id, ...envelope })
        const event = envelope.event
        // Passing states: the final message:update / agent:update is what gets saved and listed.
        if (event.type === 'message:append' || event.type === 'agent:activity') return
        if (event.type === 'message:add') entry.updatedAt = this.now().toISOString()
        if (event.type === 'title:update') entry.title = event.title
        this.scheduleSave(entry)
        if (event.type !== 'message:update') this.publishList()
      },
    })
  }

  private scheduleSave(entry: Entry): void {
    if (entry.saveTimer) clearTimeout(entry.saveTimer)
    entry.saveTimer = setTimeout(() => {
      entry.saveTimer = null
      this.save(entry)
    }, this.options.saveDelayMs ?? 400)
  }

  private save(entry: Entry): void {
    const orchestrator = entry.orchestrator
    if (!orchestrator || this.entries.get(entry.id) !== entry) return
    // Nothing worth keeping yet: an untouched new conversation stays in memory only.
    if (orchestrator.isEmpty && entry.title === DEFAULT_TITLE) return
    try {
      this.options.store.save({
        version: 1,
        id: entry.id,
        kind: 'chat',
        workdir: null,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
        ...orchestrator.content(),
      })
    } catch (error) {
      console.error(`[store] could not save ${entry.id}:`, error)
    }
  }

  private publishList(): void {
    this.options.emitConversations(this.list())
  }
}
