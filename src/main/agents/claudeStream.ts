// Parses the `--output-format stream-json` output of `claude -p` (one JSON object per line).
import path from 'node:path'
import type { AgentActivity, ToolLogEntry } from '../../shared/types'

export type ClaudeStreamEvent =
  | { kind: 'session'; sessionId: string }
  | { kind: 'model'; model: string }
  | { kind: 'commands'; canCompact: boolean }
  | { kind: 'cache'; read: number; writtenForHour: number; ttftMs: number }
  | { kind: 'compacted' }
  | { kind: 'background'; running: boolean }
  | { kind: 'activity'; activity: AgentActivity }
  | { kind: 'text'; text: string }
  | { kind: 'tool'; tool: ToolLogEntry }
  /** A request from Claude Code to the host (e.g. `can_use_tool`); the adapter answers it. */
  | { kind: 'control'; requestId: string; request: Record<string, unknown> }
  | ClaudeResult

type ClaudeResult = { kind: 'result'; matched?: boolean; command?: string; inputIds?: string[] } & (
  | { ok: true; text: string }
  | { ok: false; error: string }
)

type Json = Record<string, unknown>

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

const MAX_TITLE = 200

/** A path inside the project, shown relative to it. */
function shortPath(value: unknown, cwd: string | null): string {
  const text = typeof value === 'string' ? value : ''
  if (!cwd || !path.isAbsolute(text)) return text
  const relative = path.relative(cwd, text)
  return relative && !relative.startsWith('..') ? relative : text
}

function oneLine(value: unknown): string {
  const text = typeof value === 'string' ? value : ''
  const line = text.split('\n').find((l) => l.trim() !== '') ?? ''
  return line.length > MAX_TITLE ? `${line.slice(0, MAX_TITLE)}…` : line
}

/** `mcp__claude_ai_Notion__notion-search` → the connector (`Notion`) and its tool (`notion-search`). */
export function mcpTool(name: string): { server: string; tool: string } | null {
  const match = /^mcp__(.+?)__(.+)$/.exec(name)
  if (!match) return null
  return { server: match[1]!.replace(/^claude_ai_/, '').replace(/_/g, ' '), tool: match[2]! }
}

/** Connector tools that only read (search, fetch, get, list, …), judged by name. */
export function isReadOnlyTool(tool: string): boolean {
  return /(^|[-_.])(search|fetch|get|list|query|read|view|download)([-_.]|$)/i.test(tool)
}

/** How a Claude Code tool call is shown in the work log. */
export function describeClaudeTool(name: string, input: Json, cwd: string | null): Pick<ToolLogEntry, 'kind' | 'title'> {
  const connector = mcpTool(name)
  if (connector) {
    const query = typeof input.query === 'string' && input.query ? `「${oneLine(input.query)}」` : ''
    const kind = !isReadOnlyTool(connector.tool) ? 'other' : /search|query/i.test(connector.tool) ? 'search' : 'read'
    return { kind, title: `${connector.server}: ${connector.tool}${query}` }
  }
  switch (name) {
    case 'Read':
      return { kind: 'read', title: shortPath(input.file_path, cwd) }
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
      return { kind: 'edit', title: shortPath(input.file_path, cwd) }
    case 'NotebookEdit':
      return { kind: 'edit', title: shortPath(input.notebook_path, cwd) }
    case 'Bash':
      return { kind: 'command', title: oneLine(input.command) }
    case 'Grep':
      return { kind: 'search', title: `「${oneLine(input.pattern)}」${input.path ? ` (${shortPath(input.path, cwd)})` : ''}` }
    case 'Glob':
      return { kind: 'list', title: oneLine(input.pattern) }
    case 'LS':
      return { kind: 'list', title: shortPath(input.path, cwd) }
    case 'WebSearch':
      return { kind: 'web', title: oneLine(input.query) }
    case 'WebFetch':
      return { kind: 'web', title: oneLine(input.url) }
    default:
      return { kind: 'other', title: name }
  }
}

/** What a new content block means for the activity shown in the chat. Text is reported as text. */
function blockActivity(block: Json): AgentActivity | null {
  switch (block.type) {
    case 'thinking':
    case 'redacted_thinking':
      return { kind: 'thinking' }
    case 'server_tool_use':
    case 'tool_use':
      return block.name === 'web_search' || block.name === 'WebSearch' ? { kind: 'searching' } : { kind: 'working' }
    default:
      return null
  }
}

/**
 * Turns stream-json lines into events.
 * Text arrives as `content_block_delta` chunks (with `--include-partial-messages`).
 * When a turn holds several assistant messages, a blank line separates them.
 */
export class ClaudeStreamParser {
  private streamedText = ''
  private separatorPending = false
  /** Tool calls seen so far, to finish them when their result arrives. */
  private readonly tools = new Map<string, ToolLogEntry>()

  /** `cwd`: the project folder, so that paths can be shown relative to it. */
  constructor(private readonly cwd: string | null = null) {}

  /** Text streamed so far in this turn. */
  get text(): string {
    return this.streamedText
  }

  push(line: string, promptId?: string, idle = false, followups?: ReadonlyMap<string, unknown>): ClaudeStreamEvent[] {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) return []
    let data: unknown
    try {
      data = JSON.parse(trimmed)
    } catch {
      return []
    }
    if (!isObject(data)) return []
    if (idle && data.type !== 'system' && data.type !== 'control_request') return []

    const inputIds = Array.isArray(data.user_message_uuids) ? data.user_message_uuids.filter((id): id is string => typeof id === 'string') : []
    if (typeof data.user_message_uuid === 'string') inputIds.push(data.user_message_uuid)
    const matched = promptId !== undefined && inputIds.some((id) => id === promptId || followups?.has(id))
    if (promptId && !matched && (typeof data.user_message_uuid === 'string' || Array.isArray(data.user_message_uuids))) return []

    switch (data.type) {
      case 'system':
        return this.onSystem(data)
      case 'stream_event':
        return this.onStreamEvent(data.event, count(data.ttft_ms))
      case 'assistant':
        return this.onToolUse(data.message)
      case 'user':
        return this.onToolResult(data.message)
      case 'control_request':
        return typeof data.request_id === 'string' && isObject(data.request)
          ? [{ kind: 'control', requestId: data.request_id, request: data.request }]
          : []
      case 'result':
        if (isObject(data.origin) && data.origin.kind !== 'human' && !matched) return []
        return [{
          ...this.onResult(data),
          ...(matched ? { matched } : {}),
          ...(followups?.size ? { inputIds } : {}),
          ...(typeof data.local_command === 'string' ? { command: data.local_command } : {}),
        }]
      default:
        return []
    }
  }

  private onToolUse(message: unknown): ClaudeStreamEvent[] {
    if (!isObject(message) || !Array.isArray(message.content)) return []
    const events: ClaudeStreamEvent[] = []
    for (const block of message.content) {
      if (!isObject(block) || block.type !== 'tool_use' || typeof block.id !== 'string' || typeof block.name !== 'string') continue
      const tool: ToolLogEntry = { id: block.id, ...describeClaudeTool(block.name, isObject(block.input) ? block.input : {}, this.cwd), status: 'running' }
      this.tools.set(block.id, tool)
      events.push({ kind: 'tool', tool })
    }
    return events
  }

  private onToolResult(message: unknown): ClaudeStreamEvent[] {
    if (!isObject(message) || !Array.isArray(message.content)) return []
    const events: ClaudeStreamEvent[] = []
    for (const block of message.content) {
      if (!isObject(block) || block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue
      const started = this.tools.get(block.tool_use_id)
      if (!started) continue
      const tool: ToolLogEntry = { ...started, status: block.is_error === true ? 'failed' : 'done' }
      this.tools.set(tool.id, tool)
      events.push({ kind: 'tool', tool })
    }
    return events
  }

  private onSystem(data: Json): ClaudeStreamEvent[] {
    if (data.subtype === 'compact_boundary') return [{ kind: 'compacted' }]
    if (data.subtype === 'background_tasks_changed' && Array.isArray(data.tasks)) {
      return [{ kind: 'background', running: data.tasks.length > 0 }]
    }
    if (data.subtype !== 'init') return []
    const events: ClaudeStreamEvent[] = []
    if (typeof data.session_id === 'string') events.push({ kind: 'session', sessionId: data.session_id })
    if (typeof data.model === 'string') events.push({ kind: 'model', model: data.model })
    if (Array.isArray(data.slash_commands)) {
      events.push({ kind: 'commands', canCompact: data.slash_commands.includes('compact') || data.slash_commands.includes('/compact') })
    }
    return events
  }

  private onStreamEvent(event: unknown, ttftMs: number): ClaudeStreamEvent[] {
    if (!isObject(event)) return []
    if (event.type === 'message_start') {
      this.separatorPending = this.streamedText !== ''
      const usage = isObject(event.message) ? event.message.usage : undefined
      if (!isObject(usage)) return []
      const cache = usage.cache_creation
      return [{
        kind: 'cache',
        read: count(usage.cache_read_input_tokens),
        writtenForHour: isObject(cache) ? count(cache.ephemeral_1h_input_tokens) : 0,
        ttftMs,
      }]
    }
    if (event.type === 'content_block_start' && isObject(event.content_block)) {
      const activity = blockActivity(event.content_block)
      return activity ? [{ kind: 'activity', activity }] : []
    }
    if (event.type !== 'content_block_delta' || !isObject(event.delta)) return []
    const { delta } = event
    if (delta.type !== 'text_delta' || typeof delta.text !== 'string' || delta.text === '') return []
    const text = this.separatorPending ? `\n\n${delta.text}` : delta.text
    this.separatorPending = false
    this.streamedText += text
    return [{ kind: 'text', text }]
  }

  private onResult(data: Json): ClaudeResult {
    const isError = data.is_error === true || (typeof data.subtype === 'string' && data.subtype !== 'success')
    if (isError) {
      const errors = Array.isArray(data.errors) ? data.errors.filter((e): e is string => typeof e === 'string') : []
      const message =
        errors.join('\n') ||
        (typeof data.result === 'string' && data.result) ||
        `Claude の応答に失敗しました（${String(data.subtype ?? 'unknown')}）`
      return { kind: 'result', ok: false, error: message }
    }
    // Prefer what was streamed; fall back to the final result text.
    const text = this.streamedText || (typeof data.result === 'string' ? data.result : '')
    return { kind: 'result', ok: true, text }
  }
}
