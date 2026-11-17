// Parses the `--output-format stream-json` output of `claude -p` (one JSON object per line).
import type { AgentActivity } from '../../shared/types'

export type ClaudeStreamEvent =
  | { kind: 'session'; sessionId: string }
  | { kind: 'model'; model: string }
  | { kind: 'activity'; activity: AgentActivity }
  | { kind: 'text'; text: string }
  | { kind: 'result'; ok: true; text: string }
  | { kind: 'result'; ok: false; error: string }

type Json = Record<string, unknown>

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null
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

  /** Text streamed so far in this turn. */
  get text(): string {
    return this.streamedText
  }

  push(line: string): ClaudeStreamEvent[] {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) return []
    let data: unknown
    try {
      data = JSON.parse(trimmed)
    } catch {
      return []
    }
    if (!isObject(data)) return []

    switch (data.type) {
      case 'system':
        return this.onSystem(data)
      case 'stream_event':
        return this.onStreamEvent(data.event)
      case 'result':
        return [this.onResult(data)]
      default:
        return []
    }
  }

  private onSystem(data: Json): ClaudeStreamEvent[] {
    if (data.subtype !== 'init') return []
    const events: ClaudeStreamEvent[] = []
    if (typeof data.session_id === 'string') events.push({ kind: 'session', sessionId: data.session_id })
    if (typeof data.model === 'string') events.push({ kind: 'model', model: data.model })
    return events
  }

  private onStreamEvent(event: unknown): ClaudeStreamEvent[] {
    if (!isObject(event)) return []
    if (event.type === 'message_start') {
      this.separatorPending = this.streamedText !== ''
      return []
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

  private onResult(data: Json): ClaudeStreamEvent {
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
