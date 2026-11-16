// Types shared by the main process, the preload script and the renderer.

export const AGENT_IDS = ['claude', 'gpt'] as const
export type AgentId = (typeof AGENT_IDS)[number]

/** Who wrote a message. */
export type Sender = 'user' | AgentId

/**
 * Who a message is addressed to.
 * - The user addresses `all` or one agent.
 * - An agent replies to whoever it is answering (the user, or the other agent in dialog mode).
 */
export type Recipient = 'all' | Sender

export type MessageStatus = 'streaming' | 'done' | 'stopped' | 'error'

export interface ChatMessage {
  id: number
  from: Sender
  to: Recipient
  text: string
  /** ISO 8601 */
  at: string
  status: MessageStatus
  /** Set when status is `error`. */
  error?: string
}

export interface AgentInfo {
  id: AgentId
  /** Model reported by the CLI, once known. */
  model: string | null
  busy: boolean
}

export interface ChatState {
  title: string
  messages: ChatMessage[]
  agents: Record<AgentId, AgentInfo>
}

export type ChatEvent =
  | { type: 'message:add'; message: ChatMessage }
  | { type: 'message:append'; id: number; text: string }
  | { type: 'message:update'; message: ChatMessage }
  | { type: 'agent:update'; agent: AgentInfo }

/** Events carry a sequence number so the renderer can merge them with a snapshot. */
export interface ChatEventEnvelope {
  seq: number
  event: ChatEvent
}

export interface ChatSnapshot {
  /** Sequence number of the last event already reflected in `state`. */
  seq: number
  state: ChatState
}

export type SendTarget = 'all' | AgentId

export interface SendRequest {
  text: string
  to: SendTarget
}

/** The API the preload script exposes to the renderer as `window.agentsync`. */
export interface AgentSyncApi {
  snapshot(): Promise<ChatSnapshot>
  send(request: SendRequest): Promise<void>
  stop(): Promise<void>
  onEvent(listener: (envelope: ChatEventEnvelope) => void): () => void
}

export const MAX_MESSAGE_LENGTH = 100_000

/** Display names shown in the UI. */
export const DISPLAY_NAMES: Record<Sender, string> = {
  user: 'あなた',
  claude: 'Claude',
  gpt: 'GPT',
}
