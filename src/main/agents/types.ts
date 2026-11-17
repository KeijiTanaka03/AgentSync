import type { AgentActivity, AgentChoices, AgentId } from '../../shared/types'

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
