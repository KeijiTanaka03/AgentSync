import {
  AGENT_IDS,
  DEFAULT_TITLE,
  type AgentActivity,
  type AgentChoices,
  type AgentId,
  type AgentInfo,
  type ChatEvent,
  type ChatEventEnvelope,
  type ChatMessage,
  type ChatSnapshot,
  type SendRequest,
} from '../../shared/types'
import { titleFromMessage } from '../../shared/validate'
import type { AgentAdapter } from '../agents/types'
import type { ConversationContent, StoredParticipant } from '../store/conversationStore'
import { chatSystemPrompt, collectUnseen, formatUnseen, replyTarget } from './prompt'

interface AgentRuntime {
  info: AgentInfo
  adapter: AgentAdapter
  sessionId: string | null
  /** IDs of messages already handed to this agent's CLI session. */
  delivered: Set<number>
  controller: AbortController | null
  /** A message arrived for this agent while it was busy; run again when it finishes. */
  rerun: boolean
}

export interface OrchestratorOptions {
  /** Shared with other conversations; the orchestrator does not dispose them. */
  adapters: Record<AgentId, AgentAdapter>
  /** Working directory for chat-mode CLI sessions (an empty folder). */
  cwd: string
  emit(envelope: ChatEventEnvelope): void
  /** A saved conversation to continue. */
  initial?: ConversationContent
  /** Models for a new conversation (a saved one keeps its own). */
  models?: Partial<Record<AgentId, string | null>>
  /** Reasoning efforts for a new conversation (a saved one keeps its own). */
  efforts?: Partial<Record<AgentId, string | null>>
  now?: () => Date
}

/**
 * Holds one conversation and routes it to the agents.
 *
 * Each agent keeps its own CLI session. On each turn it receives only the messages it has
 * not seen yet (from the user and the other agent), so the whole history is never resent.
 */
export class Orchestrator {
  private readonly messages: ChatMessage[]
  private readonly agents: Record<AgentId, AgentRuntime>
  private readonly now: () => Date
  private title: string
  private nextMessageId: number
  private seq = 0

  constructor(private readonly options: OrchestratorOptions) {
    const initial = options.initial
    this.now = options.now ?? (() => new Date())
    this.title = initial?.title ?? DEFAULT_TITLE
    this.messages = (initial?.messages ?? []).map((m) => ({ ...m, status: m.status === 'streaming' ? 'stopped' : m.status }))
    this.nextMessageId = this.messages.reduce((max, m) => Math.max(max, m.id), 0) + 1
    this.agents = Object.fromEntries(
      AGENT_IDS.map((id) => {
        const saved = initial?.participants[id]
        const runtime: AgentRuntime = {
          info: {
            id,
            model: saved ? saved.model : (options.models?.[id] ?? null),
            effort: saved ? saved.effort : (options.efforts?.[id] ?? null),
            busy: false,
            activity: null,
          },
          adapter: options.adapters[id],
          sessionId: saved?.sessionId ?? null,
          delivered: new Set(saved?.delivered ?? []),
          controller: null,
          rerun: false,
        }
        return [id, runtime]
      }),
    ) as Record<AgentId, AgentRuntime>
  }

  snapshot(): ChatSnapshot {
    return {
      seq: this.seq,
      state: {
        title: this.title,
        messages: this.messages.map((m) => ({ ...m })),
        agents: Object.fromEntries(AGENT_IDS.map((id) => [id, { ...this.agents[id].info }])) as Record<AgentId, AgentInfo>,
      },
    }
  }

  /** Everything needed to continue this conversation later. */
  content(): ConversationContent {
    return {
      title: this.title,
      messages: this.messages.map((m) => ({ ...m })),
      participants: Object.fromEntries(
        AGENT_IDS.map((id) => {
          const agent = this.agents[id]
          const participant: StoredParticipant = {
            model: agent.info.model,
            effort: agent.info.effort,
            sessionId: agent.sessionId,
            delivered: [...agent.delivered].sort((a, b) => a - b),
          }
          return [id, participant]
        }),
      ) as Record<AgentId, StoredParticipant>,
    }
  }

  get isEmpty(): boolean {
    return this.messages.length === 0
  }

  get busy(): boolean {
    return AGENT_IDS.some((id) => this.agents[id].info.busy)
  }

  get currentTitle(): string {
    return this.title
  }

  send(request: SendRequest): void {
    const text = request.text.trim()
    if (!text) return
    const firstFromUser = !this.messages.some((m) => m.from === 'user')
    this.addMessage({ from: 'user', to: request.to, text, status: 'done' })
    // Name a new conversation after its first message, as Claude.ai does.
    if (firstFromUser && this.title === DEFAULT_TITLE) {
      const title = titleFromMessage(text)
      if (title) this.setTitle(title)
    }
    const targets = request.to === 'all' ? AGENT_IDS : [request.to]
    for (const id of targets) this.trigger(id)
  }

  setTitle(title: string): void {
    if (title === this.title) return
    this.title = title
    this.emit({ type: 'title:update', title })
  }

  /** Chooses how hard an agent thinks; applies from its next reply. Null leaves it to the CLI. */
  setEffort(id: AgentId, effort: string | null): void {
    if (this.agents[id].info.effort === effort) return
    this.updateAgent(id, { effort })
  }

  /** What can be chosen for an agent with its current model. */
  choices(id: AgentId): Promise<AgentChoices> {
    const agent = this.agents[id]
    return agent.adapter.choices(agent.info.model)
  }

  /** Stops every reply in progress. */
  stop(): void {
    for (const id of AGENT_IDS) {
      const agent = this.agents[id]
      agent.rerun = false
      agent.controller?.abort()
    }
  }

  private trigger(id: AgentId): void {
    const agent = this.agents[id]
    if (agent.controller) {
      agent.rerun = true
      return
    }
    void this.runTurn(id)
  }

  private async runTurn(id: AgentId): Promise<void> {
    const agent = this.agents[id]
    const unseen = collectUnseen(this.messages, id, agent.delivered)
    if (unseen.length === 0) return
    for (const m of unseen) agent.delivered.add(m.id)

    const controller = new AbortController()
    agent.controller = controller
    // Models think before they write, so a reply starts as 「考え中」.
    this.updateAgent(id, { busy: true, activity: { kind: 'thinking' } })
    const reply = this.addMessage({ from: id, to: replyTarget(unseen, id), text: '', status: 'streaming' })

    try {
      const result = await agent.adapter.run({
        prompt: formatUnseen(unseen, id),
        systemPrompt: chatSystemPrompt(id),
        sessionId: agent.sessionId,
        cwd: this.options.cwd,
        model: agent.info.model,
        effort: agent.info.effort,
        signal: controller.signal,
        onSession: (sessionId) => {
          agent.sessionId = sessionId
        },
        onModel: (model) => {
          if (model !== agent.info.model) this.updateAgent(id, { model })
        },
        onActivity: (activity) => {
          if (!controller.signal.aborted) this.setActivity(id, activity)
        },
        onText: (delta) => {
          if (controller.signal.aborted) return
          this.setActivity(id, { kind: 'writing' })
          reply.text += delta
          this.emit({ type: 'message:append', id: reply.id, text: delta })
        },
      })
      reply.text = result.text || reply.text
      reply.status = result.status
    } catch (error) {
      if (controller.signal.aborted) {
        reply.status = 'stopped'
      } else {
        reply.status = 'error'
        reply.error = error instanceof Error ? error.message : String(error)
        // The session may not have received these messages; hand them over again next time.
        for (const m of unseen) agent.delivered.delete(m.id)
      }
    } finally {
      agent.controller = null
      this.emit({ type: 'message:update', message: { ...reply } })
      this.updateAgent(id, { busy: false, activity: null })
    }

    if (agent.rerun) {
      agent.rerun = false
      void this.runTurn(id)
    }
  }

  private addMessage(fields: Omit<ChatMessage, 'id' | 'at'>): ChatMessage {
    const message: ChatMessage = { id: this.nextMessageId++, at: this.now().toISOString(), ...fields }
    this.messages.push(message)
    this.emit({ type: 'message:add', message: { ...message } })
    return message
  }

  private updateAgent(id: AgentId, patch: Partial<Omit<AgentInfo, 'id'>>): void {
    const agent = this.agents[id]
    agent.info = { ...agent.info, ...patch }
    this.emit({ type: 'agent:update', agent: { ...agent.info } })
  }

  private setActivity(id: AgentId, activity: AgentActivity): void {
    const agent = this.agents[id]
    const current = agent.info.activity
    if (current?.kind === activity.kind && current.detail === activity.detail) return
    agent.info = { ...agent.info, activity }
    this.emit({ type: 'agent:activity', id, activity })
  }

  private emit(event: ChatEvent): void {
    this.seq += 1
    this.options.emit({ seq: this.seq, event })
  }
}
