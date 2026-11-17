import type { AgentActivity, AgentChoices, AgentId, ApprovalEntry, ApprovalMode, ToolLogEntry } from '../../shared/types'

/**
 * What an agent may do on this turn. In every case the CLI keeps its own abilities (web search, the
 * connectors set up in it such as Notion); reading goes ahead, changing anything waits for the user.
 * - `chat`: a conversation without a project, in an empty folder.
 * - `read`: read and search the project, change nothing.
 * - `write`: also edit files and run commands, with the user's approval unless `approval` is `auto`.
 */
export type Access = 'chat' | 'read' | 'write'

/** What an adapter asks the user to allow. */
export type ApprovalRequest = Pick<ApprovalEntry, 'kind' | 'title' | 'detail'>

export interface AgentRunRequest {
  /** Text sent to the agent for this turn. */
  prompt: string
  systemPrompt: string
  /** CLI session (Claude) or thread (Codex) to continue. Null starts a new one. */
  sessionId: string | null
  cwd: string
  /** Null uses the CLI's default model. */
  model: string | null
  /** Reasoning effort (e.g. `low`). Null uses the CLI's own setting. */
  effort: string | null
  access: Access
  /** For `write` access. */
  approval: ApprovalMode
  signal: AbortSignal
  /** Called as soon as the CLI reports the session/thread ID. */
  onSession(sessionId: string): void
  onModel(model: string): void
  /** Called with each chunk of streamed reply text. */
  onText(delta: string): void
  /**
   * Called when the agent starts thinking, searching or using a tool.
   * (Writing is known from `onText`, so adapters need not report it.)
   */
  onActivity(activity: AgentActivity): void
  /** A step the agent took (read, edit, command, …), first as running, then finished. */
  onTool(tool: ToolLogEntry): void
  /** Asks the user before an edit or a command; resolves with their answer. */
  requestApproval(request: ApprovalRequest): Promise<'allow' | 'deny'>
}

export interface AgentRunResult {
  /** The full reply text. */
  text: string
  status: 'done' | 'stopped'
}

/** One AI participant backed by a CLI. Errors are thrown as `Error` with a message fit to show the user. */
export interface AgentAdapter {
  readonly id: AgentId
  run(request: AgentRunRequest): Promise<AgentRunResult>
  /** What can be chosen for this agent with the given model (null: the CLI's default model). */
  choices(model: string | null): Promise<AgentChoices>
  dispose(): void
}
