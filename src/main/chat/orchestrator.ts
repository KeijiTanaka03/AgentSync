import {
  AGENT_IDS,
  type AgentId,
  type AgentInfo,
  type ChatEvent,
  type ChatEventEnvelope,
  type ChatMessage,
  type ChatSnapshot,
  type SendRequest,
} from '../../shared/types'
import type { AgentAdapter } from '../agents/types'
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
  adapters: Record<AgentId, AgentAdapter>
  /** Working directory for chat-mode CLI sessions (an empty folder). */
  cwd: string
  emit(envelope: ChatEventEnvelope): void
  models?: Partial<Record<AgentId, string | null>>
  title?: string
  now?: () => Date
}

/**
 * Holds one conversation and routes it to the agents.
 *
 * Each agent keeps its own CLI session. On each turn it receives only the messages it has
 * not seen yet (from the user and the other agent), so the whole history is never resent.
 */
export class Orchestrator {
  private readonly messages: ChatMessage[] = []
  private readonly agents: Record<AgentId, AgentRuntime>
  private readonly title: string
  private readonly now: () => Date
  private nextMessageId = 1
  private seq = 0

  constructor(private readonly options: OrchestratorOptions) {
    this.title = options.title ?? '新しい会話'
    this.now = options.now ?? (() => new Date())
    this.agents = Object.fromEntries(
      AGENT_IDS.map((id) => [
        id,
        {
          info: { id, model: options.models?.[id] ?? null, busy: false },
          adapter: options.adapters[id],
          sessionId: null,
          delivered: new Set<number>(),
          controller: null,
          rerun: false,
        } satisfies AgentRuntime,
      ]),
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

  send(request: SendRequest): void {
    const text = request.text.trim()
    if (!text) return
    this.addMessage({ from: 'user', to: request.to, text, status: 'done' })
    const targets = request.to === 'all' ? AGENT_IDS : [request.to]
    for (const id of targets) this.trigger(id)
  }

  /** Stops every reply in progress. */
  stop(): void {
    for (const id of AGENT_IDS) {
      const agent = this.agents[id]
      agent.rerun = false
      agent.controller?.abort()
    }
  }

  dispose(): void {
    this.stop()
    for (const id of AGENT_IDS) this.agents[id].adapter.dispose()
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
    this.updateAgent(id, { busy: true })
    const reply = this.addMessage({ from: id, to: replyTarget(unseen, id), text: '', status: 'streaming' })

    try {
      const result = await agent.adapter.run({
        prompt: formatUnseen(unseen, id),
        systemPrompt: chatSystemPrompt(id),
        sessionId: agent.sessionId,
        cwd: this.options.cwd,
        model: agent.info.model,
        signal: controller.signal,
        onSession: (sessionId) => {
          agent.sessionId = sessionId
        },
        onModel: (model) => {
          if (model !== agent.info.model) this.updateAgent(id, { model })
        },
        onText: (delta) => {
          if (controller.signal.aborted) return
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
      this.updateAgent(id, { busy: false })
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

  private emit(event: ChatEvent): void {
    this.seq += 1
    this.options.emit({ seq: this.seq, event })
  }
}
