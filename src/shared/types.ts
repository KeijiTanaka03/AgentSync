// Types shared by the main process, the preload script and the renderer.

export const AGENT_IDS = ['claude', 'gpt'] as const
export type AgentId = (typeof AGENT_IDS)[number]

export function isAgentId(value: unknown): value is AgentId {
  return AGENT_IDS.includes(value as AgentId)
}

export function otherAgent(id: AgentId): AgentId {
  return id === 'claude' ? 'gpt' : 'claude'
}

/** Who wrote a message. `system` is AgentSync itself (notices such as 「ここから対話モード」). */
export type Sender = 'user' | AgentId | 'system'

/**
 * Who a message is addressed to.
 * - The user addresses `all` or one agent.
 * - An agent replies to whoever it is answering (the user, or the other agent in dialogue mode).
 * - Notices are for `all`.
 */
export type Recipient = 'all' | 'user' | AgentId

/** What a notice from AgentSync is about. */
export type NoticeKind = 'dialogue-start' | 'dialogue-stop' | 'review-start' | 'review-diff' | 'review-stop'

export type MessageStatus = 'streaming' | 'done' | 'stopped' | 'error'

/** A chat talks only. A coding conversation works in a project folder the user chose. */
export type ConversationKind = 'chat' | 'code'

/**
 * How a coding conversation's agent may change the project.
 * - `ask` (承認制): every edit and command waits for the user's approval; reading and searching do not.
 * - `auto`: the CLI's own auto mode decides; only what it stops at is shown for approval.
 */
export type ApprovalMode = 'ask' | 'auto'

/** One step an agent took while replying in a coding conversation (read a file, ran a command, …). */
export interface ToolLogEntry {
  id: string
  kind: 'read' | 'search' | 'list' | 'edit' | 'command' | 'web' | 'other'
  /** One line: a path, a command, a search pattern. */
  title: string
  status: 'running' | 'done' | 'failed'
}

/** Something an agent asked the user to allow. */
export interface ApprovalEntry {
  id: string
  kind: 'command' | 'edit' | 'other'
  /** What it wants to do, in a line. */
  title: string
  /** The command or the diff, when there is one. */
  detail: string | null
  status: 'pending' | 'allowed' | 'denied'
}

/** The user's answer to an approval card. `allow-all`: this one and the rest of this reply. */
export type ApprovalDecision = 'allow' | 'allow-all' | 'deny'

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
  /** Set on notices (messages from `system`). */
  notice?: NoticeKind
  /** `review-start` notices: who implements (the other agent reviews). */
  implementer?: AgentId
  /** `review-diff` notices: the changes handed to the reviewer (git diff). */
  detail?: string
  /** Coding conversations: the steps the agent took for this reply, in order. */
  tools?: ToolLogEntry[]
  /** Coding conversations: what the agent asked to be allowed during this reply. */
  approvals?: ApprovalEntry[]
}

/** What an agent is doing while it replies. */
export type ActivityKind = 'thinking' | 'searching' | 'working' | 'waiting' | 'writing'

export interface AgentActivity {
  kind: ActivityKind
  /** Shown next to the label, e.g. what is being searched for. */
  detail?: string
}

export interface AgentInfo {
  id: AgentId
  /** Model chosen in AgentSync (an alias such as `sonnet`, or an ID). Null leaves it to the CLI's own setting. */
  model: string | null
  /** The model the CLI says it is using, once a reply has started. */
  activeModel: string | null
  /** Reasoning effort chosen in AgentSync (e.g. `low`). Null leaves it to the CLI's own setting. */
  effort: string | null
  busy: boolean
  /** What the agent is doing right now; null when it is not replying. */
  activity: AgentActivity | null
}

/** Dialogue mode: Claude and GPT take turns until it is stopped. */
export interface DialogueState {
  /** Who speaks next (or is speaking now). */
  next: AgentId
  /** Replies so far in this dialogue. */
  turns: number
}

/** The project folder of a coding conversation. */
export interface Workspace {
  path: string
  /** The folder's name, for showing. */
  name: string
  /** The checked-out git branch, when it is a repository. */
  branch: string | null
}

/** 実装＋レビュー: one agent changes the project, the other reviews the diff, until APPROVED or the limit. */
export interface ReviewState {
  implementer: AgentId
  reviewer: AgentId
  /** The round running now, from 1. */
  round: number
  maxRounds: number
  phase: 'implement' | 'review'
}

/**
 * Coding conversations: who may change the project.
 * - `single`: whoever a message is addressed to; read-only when both are asked at once
 * - an agent: that agent implements each request and the other reviews it (実装＋レビュー)
 */
export type Roles = 'single' | AgentId

export interface ChatState {
  title: string
  kind: ConversationKind
  /** Coding conversations only. */
  workspace: Workspace | null
  approvalMode: ApprovalMode
  /** Coding: who may change the project (see Roles). */
  roles: Roles
  messages: ChatMessage[]
  agents: Record<AgentId, AgentInfo>
  /** Null when dialogue mode is off. */
  dialogue: DialogueState | null
  /** Null when no 実装＋レビュー is running. */
  review: ReviewState | null
}

export type ChatEvent =
  | { type: 'message:add'; message: ChatMessage }
  | { type: 'message:append'; id: number; text: string }
  | { type: 'message:update'; message: ChatMessage }
  | { type: 'agent:update'; agent: AgentInfo }
  /** Changes often while replying; not saved. */
  | { type: 'agent:activity'; id: AgentId; activity: AgentActivity | null }
  | { type: 'title:update'; title: string }
  | { type: 'dialogue:update'; dialogue: DialogueState | null }
  | { type: 'review:update'; review: ReviewState | null }
  /** A step of a reply was added or changed (matched by `tool.id`). */
  | { type: 'message:tool'; id: number; tool: ToolLogEntry }
  /** An approval card was added or answered (matched by `approval.id`). */
  | { type: 'message:approval'; id: number; approval: ApprovalEntry }
  | { type: 'workspace:update'; workspace: Workspace | null; approvalMode: ApprovalMode; roles: Roles }

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
  /** Dialogue mode is on. */
  dialogue: boolean
  /** 実装＋レビュー is running. */
  review: boolean
  /** Kept at the top of the list. */
  pinned: boolean
  kind: ConversationKind
}

export type SendTarget = 'all' | AgentId

export interface SendRequest {
  text: string
  to: SendTarget
}

/** A model an agent's CLI offers. */
export interface ModelChoice {
  /** What is passed to the CLI (`sonnet`, `gpt-6.1-sol`, …). */
  value: string
  label: string
  description: string | null
}

/** What can be chosen for an agent in the header menu. */
export interface AgentChoices {
  /** The models the CLI offers, as it lists them. */
  models: ModelChoice[]
  /** The model used when none is chosen (a label), when the CLI says. */
  defaultModel: string | null
  /** Whether another model ID can be typed in (Claude Code accepts any). */
  customModel: boolean
  /** Reasoning efforts for the conversation's current model, from lightest to deepest. */
  efforts: string[]
  /** The effort used when none is chosen, when the CLI says (Codex does; Claude Code does not). */
  defaultEffort: string | null
}

/** One usage limit of a plan (e.g. the 5-hour window). */
export interface UsageWindow {
  label: string
  usedPercent: number
  /** When it resets, as text for showing (null when unknown). */
  resets: string | null
}

export interface UsageReport {
  windows: UsageWindow[]
  /** Why it could not be read. */
  error: string | null
}

/** The CLIs whose connectors can be managed. */
export type CliId = 'claude' | 'codex'

/** A connector (MCP server) set up in a CLI. */
export interface Connection {
  name: string
  /** URL or command. */
  target: string
  status: 'connected' | 'needs-auth' | 'failed' | 'disabled' | 'unknown'
  /** Managed in claude.ai's settings rather than in the CLI. */
  managedAtClaudeAi: boolean
}

export interface ConnectionList {
  connections: Connection[]
  error: string | null
}

/** Commands sent from the app menu to the renderer. */
export type MenuCommand = 'new-conversation' | 'new-code-conversation' | 'toggle-dialogue' | 'stop' | 'connections' | 'usage'

/** The API the preload script exposes to the renderer as `window.agentsync`. */
export interface AgentSyncApi {
  listConversations(): Promise<ConversationSummary[]>
  /** Returns the ID of a new, empty conversation (an existing empty one is reused). */
  createConversation(): Promise<string>
  /** Asks for a project folder, then returns the ID of a new coding conversation (null when cancelled). */
  createCodeConversation(): Promise<string | null>
  renameConversation(id: string, title: string): Promise<void>
  /** Pinned conversations stay at the top of the list. */
  pinConversation(id: string, pinned: boolean): Promise<void>
  /** Asks for confirmation first. Resolves to true when the conversation was deleted. */
  deleteConversation(id: string): Promise<boolean>
  snapshot(conversationId: string): Promise<ChatSnapshot>
  agentChoices(conversationId: string, agent: AgentId): Promise<AgentChoices>
  /** Applies from the agent's next reply, and becomes the default for new conversations. */
  setEffort(conversationId: string, agent: AgentId, effort: string | null): Promise<void>
  /** Like `setEffort`. An effort the new model does not accept goes back to the CLI's own setting. */
  setModel(conversationId: string, agent: AgentId, model: string | null): Promise<void>
  send(conversationId: string, request: SendRequest): Promise<void>
  stop(conversationId: string): Promise<void>
  /** Turns dialogue mode on or off. */
  setDialogue(conversationId: string, on: boolean): Promise<void>
  /**
   * Starts 実装＋レビュー with this implementer (the other agent reviews), or stops it with null.
   * `task`: the request, posted first without asking anyone to reply; otherwise the last request is used.
   */
  setReview(conversationId: string, implementer: AgentId | null, task?: string): Promise<void>
  /** Answers an approval card. */
  approve(conversationId: string, approvalId: string, decision: ApprovalDecision): Promise<void>
  setApprovalMode(conversationId: string, mode: ApprovalMode): Promise<void>
  /** Coding: chooses the roles. Nothing starts until a request is sent. */
  setRoles(conversationId: string, roles: Roles): Promise<void>
  /** Each plan's usage limits, read from the CLIs without using any. */
  usage(): Promise<Record<AgentId, UsageReport>>
  listConnections(): Promise<Record<CliId, ConnectionList>>
  /** Adds a connector reached over HTTP (`url`). */
  addConnection(cli: CliId, name: string, url: string): Promise<void>
  /** Asks for confirmation first. Resolves to true when removed. */
  removeConnection(cli: CliId, name: string): Promise<boolean>
  /** Starts signing in to a connector (in the browser). Returns what to tell the user. */
  loginConnection(cli: CliId, name: string): Promise<string>
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
  system: 'AgentSync',
}
