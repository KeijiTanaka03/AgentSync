import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ClaudeAdapter, describePermission, parseModelList, writesOutside } from '../src/main/agents/claude'
import { ClaudeStreamParser } from '../src/main/agents/claudeStream'
import type { AgentRunRequest, ApprovalRequest } from '../src/main/agents/types'
import type { ToolLogEntry } from '../src/shared/types'

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
    const args = ClaudeAdapter.buildArgs({ systemPrompt: 'SYS', model: 'haiku', effort: 'low', sessionId: 'sess-1', access: 'chat', approval: 'ask' })
    expect(args).toEqual([
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--strict-mcp-config',
      '--tools',
      '',
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
    const args = ClaudeAdapter.buildArgs({ systemPrompt: 'SYS', model: null, effort: null, sessionId: null, access: 'chat', approval: 'ask' })
    expect(args).not.toContain('--model')
    expect(args).not.toContain('--effort')
    expect(args).not.toContain('--resume')
  })
})

// Shape of Claude Code's answer to an `initialize` control request (trimmed).
const MODELS = [
  { value: 'default', resolvedModel: 'claude-opus-5-5', displayName: 'Default (recommended)', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { value: 'sonnet', resolvedModel: 'claude-sonnet-5-5', displayName: 'Sonnet 5.5', description: 'Most efficient', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high'] },
  { value: 'claude-haiku-4-5-20251001', displayName: 'Haiku 4.5', description: 'Fastest' },
]
const initializeAnswer = JSON.stringify({
  type: 'control_response',
  response: { subtype: 'success', request_id: 'agentsync-models', response: { models: MODELS, account: { email: 'someone@example.com' } } },
})

describe('Claude model list', () => {
  it('reads the models from the initialize answer and ignores other lines', () => {
    expect(parseModelList(initializeAnswer)?.map((m) => m.value)).toEqual(['default', 'sonnet', 'claude-haiku-4-5-20251001'])
    expect(parseModelList(JSON.stringify({ type: 'system', subtype: 'init' }))).toBeNull()
    expect(parseModelList('not json')).toBeNull()
  })

  it('offers the models (「default」 is 「自動」) with the efforts of the model in use, and lets an ID be typed', async () => {
    // A stand-in for `claude` that answers the initialize request.
    const folder = mkdtempSync(path.join(tmpdir(), 'agentsync-fake-claude-'))
    const binary = path.join(folder, 'claude')
    writeFileSync(binary, `#!/bin/sh\nread line\nprintf '%s\\n' '${initializeAnswer}'\nsleep 5\n`)
    chmodSync(binary, 0o755)
    const adapter = new ClaudeAdapter({ resolveBinary: async () => binary, env: () => process.env, listCwd: folder })

    const auto = await adapter.choices(null)
    expect(auto).toEqual({
      models: [
        { value: 'sonnet', label: 'Sonnet 5.5', description: 'Most efficient' },
        { value: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5', description: 'Fastest' },
      ],
      defaultModel: null,
      customModel: true,
      efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      defaultEffort: null,
    })
    expect((await adapter.choices('sonnet')).efforts).toEqual(['low', 'medium', 'high'])
    expect((await adapter.choices('claude-sonnet-5-5')).efforts).toEqual(['low', 'medium', 'high']) // by full ID
    expect((await adapter.choices('claude-haiku-4-5-20251001')).efforts).toEqual([]) // no effort setting
    expect((await adapter.choices('my-custom-model')).efforts).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    adapter.dispose()
  })
})

describe('Claude in a coding conversation', () => {
  const base = { systemPrompt: 'SYS', model: null, effort: null, sessionId: null }

  it('works as Claude Code does, reading only or asking us before changes', () => {
    const read = ClaudeAdapter.buildArgs({ ...base, access: 'read', approval: 'ask' })
    expect(read).toEqual(expect.arrayContaining(['--append-system-prompt', 'SYS', '--tools', 'Read,Glob,Grep', '--permission-prompts', 'none']))
    expect(read).not.toContain('--system-prompt')

    const ask = ClaudeAdapter.buildArgs({ ...base, access: 'write', approval: 'ask' })
    expect(ask.join(' ')).toContain('--input-format stream-json --permission-mode manual --permission-prompts host --permission-prompt-tool stdio')
    expect(ask).not.toContain('--tools')
    expect(ClaudeAdapter.buildArgs({ ...base, access: 'write', approval: 'auto' }).join(' ')).toContain('--permission-mode auto')
  })

  it('reports each tool call as a step, then finishes it with its result', () => {
    const parser = new ClaudeStreamParser('/work/app')
    const events = [
      line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/work/app/src/a.ts' } }] } }),
      line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'npm test\n# again' } }] } }),
      line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: '...' }] } }),
      line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't2', is_error: true, content: 'failed' }] } }),
      line({ type: 'control_request', request_id: 'r1', request: { subtype: 'can_use_tool', tool_name: 'Bash' } }),
    ].flatMap((l) => parser.push(l))
    expect(events).toEqual([
      { kind: 'tool', tool: { id: 't1', kind: 'read', title: 'src/a.ts', status: 'running' } },
      { kind: 'tool', tool: { id: 't2', kind: 'command', title: 'npm test', status: 'running' } },
      { kind: 'tool', tool: { id: 't1', kind: 'read', title: 'src/a.ts', status: 'done' } },
      { kind: 'tool', tool: { id: 't2', kind: 'command', title: 'npm test', status: 'failed' } },
      { kind: 'control', requestId: 'r1', request: { subtype: 'can_use_tool', tool_name: 'Bash' } },
    ])
  })

  it('describes what a permission request would do', () => {
    expect(describePermission('Bash', { command: 'rm -rf build' }, '/work/app')).toEqual({ kind: 'command', title: 'コマンドを実行: rm -rf build', detail: 'rm -rf build' })
    const edit = describePermission('Edit', { file_path: '/work/app/a.ts', old_string: 'a', new_string: 'b' }, '/work/app')
    expect(edit).toEqual({ kind: 'edit', title: 'ファイルを編集: a.ts', detail: '- a\n+ b' })
    expect(writesOutside('Write', { file_path: '/work/app/x' }, '/work/app')).toBe(false)
    expect(writesOutside('Write', { file_path: '/etc/hosts' }, '/work/app')).toBe(true)
    expect(writesOutside('Edit', { file_path: '../other/x' }, '/work/app')).toBe(true)
    expect(writesOutside('Bash', { command: 'ls' }, '/work/app')).toBe(false)
  })

  it('relays a permission request to the user and passes the answer back', async () => {
    // A stand-in for `claude` with stream-json input: asks to run a command, then reports what it was told.
    const folder = mkdtempSync(path.join(tmpdir(), 'agentsync-fake-claude-'))
    const binary = path.join(folder, 'claude')
    const ask = JSON.stringify({ type: 'control_request', request_id: 'r1', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'rm -rf build' } } })
    writeFileSync(
      binary,
      [
        '#!/bin/sh',
        'read message',
        `printf '%s\\n' '${ask}'`,
        'read answer',
        'case "$answer" in *\'"behavior":"allow"\'*) verdict=allowed ;; *) verdict=denied ;; esac',
        'printf \'{"type":"result","subtype":"success","is_error":false,"result":"%s"}\\n\' "$verdict"',
        'read rest',
      ].join('\n') + '\n',
    )
    chmodSync(binary, 0o755)
    const adapter = new ClaudeAdapter({ resolveBinary: async () => binary, env: () => process.env })
    const asked: ApprovalRequest[] = []
    const tools: ToolLogEntry[] = []
    const request = (answer: 'allow' | 'deny'): AgentRunRequest => ({
      prompt: 'build を消して',
      systemPrompt: 'SYS',
      sessionId: null,
      cwd: folder,
      model: null,
      effort: null,
      access: 'write',
      approval: 'ask',
      signal: new AbortController().signal,
      onSession: () => {},
      onModel: () => {},
      onText: () => {},
      onActivity: () => {},
      onTool: (tool) => tools.push(tool),
      requestApproval: async (req) => {
        asked.push(req)
        return answer
      },
    })
    await expect(adapter.run(request('allow'))).resolves.toEqual({ text: 'allowed', status: 'done' })
    expect(asked).toEqual([{ kind: 'command', title: 'コマンドを実行: rm -rf build', detail: 'rm -rf build' }])
    await expect(adapter.run(request('deny'))).resolves.toEqual({ text: 'denied', status: 'done' })
  })
})

