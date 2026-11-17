import { describe, expect, it } from 'vitest'
import { ClaudeAdapter } from '../src/main/agents/claude'
import { ClaudeStreamParser } from '../src/main/agents/claudeStream'

// Shapes taken from real `claude -p --output-format stream-json --verbose --include-partial-messages` output.
const line = (value: unknown) => JSON.stringify(value)
const init = line({ type: 'system', subtype: 'init', session_id: 'sess-1', model: 'claude-haiku-5-5', tools: [] })
const messageStart = line({ type: 'stream_event', event: { type: 'message_start', message: {} } })
const delta = (text: string) =>
  line({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } })

describe('ClaudeStreamParser', () => {
  it('reports session, model, streamed text and the result', () => {
    const parser = new ClaudeStreamParser()
    const events = [
      init,
      line({ type: 'system', subtype: 'status', status: 'requesting' }),
      messageStart,
      delta('テ'),
      delta('スト成功'),
      line({ type: 'assistant', message: { content: [{ type: 'text', text: 'テスト成功' }] } }),
      line({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } }),
      line({ type: 'result', subtype: 'success', is_error: false, result: 'テスト成功', session_id: 'sess-1' }),
    ].flatMap((l) => parser.push(l))

    expect(events).toEqual([
      { kind: 'session', sessionId: 'sess-1' },
      { kind: 'model', model: 'claude-haiku-5-5' },
      { kind: 'text', text: 'テ' },
      { kind: 'text', text: 'スト成功' },
      { kind: 'result', ok: true, text: 'テスト成功' },
    ])
  })

  it('separates consecutive assistant messages with a blank line', () => {
    const parser = new ClaudeStreamParser()
    const texts = [messageStart, delta('一つ目'), messageStart, delta('二つ目')]
      .flatMap((l) => parser.push(l))
      .map((e) => (e.kind === 'text' ? e.text : ''))
    expect(texts.join('')).toBe('一つ目\n\n二つ目')
  })

  it('reports thinking and tool use when such a block starts', () => {
    const parser = new ClaudeStreamParser()
    const blockStart = (content_block: unknown) => line({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block } })
    const events = [
      messageStart,
      blockStart({ type: 'thinking', thinking: '', signature: '' }),
      line({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '' } } }),
      blockStart({ type: 'text', text: '' }),
      delta('答え'),
      blockStart({ type: 'server_tool_use', id: 't1', name: 'web_search', input: {} }),
      blockStart({ type: 'tool_use', id: 't2', name: 'Read', input: {} }),
    ].flatMap((l) => parser.push(l))

    expect(events).toEqual([
      { kind: 'activity', activity: { kind: 'thinking' } },
      { kind: 'text', text: '答え' },
      { kind: 'activity', activity: { kind: 'searching' } },
      { kind: 'activity', activity: { kind: 'working' } },
    ])
  })

  it('falls back to the result text when nothing was streamed', () => {
    const parser = new ClaudeStreamParser()
    expect(parser.push(line({ type: 'result', subtype: 'success', result: 'まとめて' }))).toEqual([
      { kind: 'result', ok: true, text: 'まとめて' },
    ])
  })

  it('turns an error result into a readable message', () => {
    const parser = new ClaudeStreamParser()
    const [event] = parser.push(
      line({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['No conversation found with session ID: x'] }),
    )
    expect(event).toEqual({ kind: 'result', ok: false, error: 'No conversation found with session ID: x' })
  })

  it('ignores non-JSON lines', () => {
    expect(new ClaudeStreamParser().push('warning: something')).toEqual([])
    expect(new ClaudeStreamParser().push('{broken')).toEqual([])
  })
})

describe('ClaudeAdapter.buildArgs', () => {
  it('disables tools and MCP servers and resumes the session when there is one', () => {
    const args = ClaudeAdapter.buildArgs({ systemPrompt: 'SYS', model: 'haiku', effort: 'low', sessionId: 'sess-1' })
    expect(args).toEqual([
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--tools',
      '',
      '--strict-mcp-config',
      '--system-prompt',
      'SYS',
      '--model',
      'haiku',
      '--effort',
      'low',
      '--resume',
      'sess-1',
    ])
  })

  it('leaves out model, effort and resume when not set', () => {
    const args = ClaudeAdapter.buildArgs({ systemPrompt: 'SYS', model: null, effort: null, sessionId: null })
    expect(args).not.toContain('--model')
    expect(args).not.toContain('--effort')
    expect(args).not.toContain('--resume')
  })
})
