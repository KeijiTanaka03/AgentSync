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

/** What an agent is doing while it replies. */
export type ActivityKind = 'thinking' | 'searching' | 'working' | 'writing'

export interface AgentActivity {
  kind: ActivityKind
  /** Shown next to the label, e.g. what is being searched for. */
  detail?: string
}

export interface AgentInfo {
  id: AgentId
  /** Model reported by the CLI, once known. */
  model: string | null
  /** Reasoning effort chosen in AgentSync (e.g. `low`). Null leaves it to the CLI's own setting. */
  effort: string | null
  busy: boolean
  /** What the agent is doing right now; null when it is not replying. */
  activity: AgentActivity | null
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
  /** Changes often while replying; not saved. */
  | { type: 'agent:activity'; id: AgentId; activity: AgentActivity | null }
  | { type: 'title:update'; title: string }

/** Events carry a sequence number so the renderer can merge them with a snapshot. */
export interface ChatEventEnvelope {
  seq: number
  event: ChatEvent
}

/** An event of one conversation, as sent to the renderer. */
export interface ConversationEventEnvelope extends ChatEventEnvelope {
  conversationId: string
}

export interface ChatSnapshot {
  /** Sequence number of the last event already reflected in `state`. */
  seq: number
  state: ChatState
}

/** One row of the conversation list in the sidebar. */
export interface ConversationSummary {
  id: string
  title: string
  /** ISO 8601. The list is sorted by this, newest first. */
  updatedAt: string
  /** An agent is replying in this conversation right now. */
  busy: boolean
}

export type SendTarget = 'all' | AgentId

export interface SendRequest {
  text: string
  to: SendTarget
}

/** What can be chosen for an agent in the header menu. */
export interface AgentChoices {
  /** Reasoning efforts the CLI accepts for the current model, from lightest to deepest. */
  efforts: string[]
  /** The effort the CLI uses when none is chosen, when it says (Codex does; Claude Code does not). */
  defaultEffort: string | null
}

/** Commands sent from the app menu to the renderer. */
export type MenuCommand = 'new-conversation'

/** The API the preload script exposes to the renderer as `window.agentsync`. */
export interface AgentSyncApi {
  listConversations(): Promise<ConversationSummary[]>
  /** Returns the ID of a new, empty conversation (an existing empty one is reused). */
  createConversation(): Promise<string>
  renameConversation(id: string, title: string): Promise<void>
  /** Asks for confirmation first. Resolves to true when the conversation was deleted. */
  deleteConversation(id: string): Promise<boolean>
  snapshot(conversationId: string): Promise<ChatSnapshot>
  agentChoices(conversationId: string, agent: AgentId): Promise<AgentChoices>
  /** Applies from the agent's next reply, and becomes the default for new conversations. */
  setEffort(conversationId: string, agent: AgentId, effort: string | null): Promise<void>
  send(conversationId: string, request: SendRequest): Promise<void>
  stop(conversationId: string): Promise<void>
  onEvent(listener: (envelope: ConversationEventEnvelope) => void): () => void
  onConversations(listener: (conversations: ConversationSummary[]) => void): () => void
  onMenuCommand(listener: (command: MenuCommand) => void): () => void
}

export const MAX_MESSAGE_LENGTH = 100_000
export const MAX_TITLE_LENGTH = 120
export const DEFAULT_TITLE = '新しい会話'

/** Display names shown in the UI. */
export const DISPLAY_NAMES: Record<Sender, string> = {
  user: 'あなた',
  claude: 'Claude',
  gpt: 'GPT',
}
