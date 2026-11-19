import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ClaudeAdapter } from '../src/main/agents/claude'
import type { AgentRunRequest } from '../src/main/agents/types'

const MINUTE = 60_000
const realSetTimeout = setTimeout
const cleanups: (() => void)[] = []

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

function setup() {
  const directory = mkdtempSync(path.join(tmpdir(), 'agentsync-claude-session-'))
  const binary = path.join(directory, 'claude')
  const log = path.join(directory, 'stdin.jsonl')
  writeFileSync(binary, `#!/usr/bin/env node
const fs = require('node:fs')
const readline = require('node:readline')
const response = (message) => console.log(JSON.stringify(message))
const args = process.argv.slice(2)
const resume = args.indexOf('--resume')
const session = resume < 0 ? String(process.pid) : args[resume + 1]
const record = (message) => fs.appendFileSync(process.env.TEST_INPUT_LOG, JSON.stringify(message) + '\\n')
let steeringTurn
let pendingEdit
let hanging
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const input = JSON.parse(line)
  if (input.type === 'control_request' && input.request.subtype === 'interrupt') {
    record({ interrupt: true, pid: process.pid })
    response({ type: 'control_response', response: { subtype: 'success', request_id: input.request_id, response: { still_queued: [] } } })
    if (hanging) response({ type: 'result', subtype: 'error_during_execution', is_error: true, session_id: session, user_message_uuid: hanging, errors: [] })
    return
  }
  if (input.type === 'control_response') {
    record({ control: input.response.response, pid: process.pid })
    response({ type: 'result', subtype: 'success', session_id: session, result: 'edit', user_message_uuid: pendingEdit })
    return
  }
  if (input.type !== 'user') return
  const content = input.message.content
  const prompt = Array.isArray(content) ? content[0].text : content
  record({ prompt, content, pid: process.pid, args, session })
  response({ type: 'system', subtype: 'init', session_id: session, model: 'opus', slash_commands: ['compact'] })
  if (input.priority === 'next' && steeringTurn) {
    response({ type: 'result', subtype: 'success', result: prompt, user_message_uuids: [steeringTurn, input.uuid] })
    return
  }
  const result = { type: 'result', subtype: 'success', session_id: session, result: prompt }
  if (prompt !== 'legacy') result.user_message_uuid = input.uuid
  if (prompt === '/compact' && fs.existsSync('no-compact')) {
    response({ ...result, local_command: 'compact' })
    return
  }
  if (prompt === '/compact') {
    setTimeout(() => {
      response({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'manual', pre_tokens: 300000 } })
      response({ ...result, local_command: 'compact' })
    }, 120)
    return
  }
  if (prompt === 'hang') {
    hanging = input.uuid
    response({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '途中' } } })
    return
  }
  if (prompt === 'stuck') return
  if (prompt === 'mcp') {
    pendingEdit = input.uuid
    response({ type: 'control_request', request_id: 'r2', request: { subtype: 'can_use_tool', tool_name: 'mcp__other__delete_page', input: { id: 'p1' } } })
    return
  }
  if (prompt === 'edit') {
    pendingEdit = input.uuid
    response({ type: 'control_request', request_id: 'r1', request: { subtype: 'can_use_tool', tool_name: 'Edit', input: { file_path: 'a.ts', old_string: 'a', new_string: 'b' } } })
    return
  }
  const read = prompt === 'cache hit' ? 290000 : 0
  const forHour = prompt === 'large' ? 300000 : prompt === 'short' ? 50000 : 0
  const forFiveMinutes = prompt === 'five minutes' ? 300000 : 0
  response({ type: 'stream_event', event: { type: 'message_start', message: { usage: {
    cache_read_input_tokens: read,
    cache_creation_input_tokens: forHour + forFiveMinutes,
    cache_creation: { ephemeral_1h_input_tokens: forHour, ephemeral_5m_input_tokens: forFiveMinutes },
  } } } })
  if (prompt === '途中で追記') steeringTurn = input.uuid
  else response(result)
})
`)
  chmodSync(binary, 0o755)
  const adapter = new ClaudeAdapter({
    resolveBinary: async () => binary,
    env: () => ({ ...process.env, CLAUDE_CONFIG_DIR: directory, TEST_INPUT_LOG: log }),
  })
  cleanups.push(() => {
    adapter.dispose()
    rmSync(directory, { recursive: true, force: true })
  })
  const onTool = vi.fn()
  let sessionId: string | null = null
  const run = (prompt: string, options: Partial<AgentRunRequest> = {}) => adapter.run({
    prompt,
    systemPrompt: 'SYS',
    askUser: async () => null,
    cwd: directory,
    sessionId,
    model: 'opus',
    effort: 'medium',
    access: 'write',
    approval: 'auto',
    signal: new AbortController().signal,
    onActivity: () => {},
    onSession: (id) => { sessionId = id },
    onModel: () => {},
    onText: () => {},
    onTool,
    requestApproval: async () => 'deny',
    ...options,
  })
  const recorded = (): { prompt: string; content: unknown; pid: number; args: string[]; session: string }[] =>
    existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []
  const transcript = (id: string, at: string, tokens: number) => {
    mkdirSync(path.join(directory, 'projects', 'project'), { recursive: true })
    const usage = { input_tokens: 10, cache_read_input_tokens: tokens, cache_creation_input_tokens: 0 }
    writeFileSync(path.join(directory, 'projects', 'project', `${id}.jsonl`), [
      { type: 'user', timestamp: at, message: { role: 'user', content: 'x' } },
      { type: 'assistant', timestamp: at, message: { role: 'assistant', usage } },
    ].map((entry) => JSON.stringify(entry)).join('\n') + '\n')
  }
  return { run, recorded, adapter, onTool, directory, transcript, sessionId: () => sessionId }
}

function clock() {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  let time = 1_000_000
  const now = vi.spyOn(Date, 'now').mockImplementation(() => time)
  return async (elapsed: number, asleep = 0) => {
    time += elapsed + asleep
    now.mockReturnValue(time)
    await vi.advanceTimersByTimeAsync(elapsed)
  }
}

async function waitUntil(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (check()) return
    await new Promise((resolve) => realSetTimeout(resolve, 10))
  }
  throw new Error('Claude fixture did not respond')
}

describe('Claude Code live sessions', () => {
  it('delivers a follow-up on the live stream and checks its UUID in the result', async () => {
    const { run } = setup()
    let steer: ((text: string) => Promise<boolean>) | undefined
    const reply = run('途中で追記', { onSteer: (send) => { steer = send } })
    await waitUntil(() => steer !== undefined)
    await expect(steer!('テスト不要です')).resolves.toBe(true)
    await expect(reply).resolves.toEqual({ text: 'テスト不要です', status: 'done' })
  })

  it('sends images as image blocks and leaves other files to be read by path, as Claude Code does', async () => {
    const { run, recorded, directory } = setup()
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR1sAAAAASUVORK5CYII=', 'base64')
    const pdf = Buffer.from('%PDF-1.4\n')
    const imagePath = path.join(directory, 'image.png')
    const pdfPath = path.join(directory, 'document.pdf')
    writeFileSync(imagePath, png)
    writeFileSync(pdfPath, pdf)
    expect(await run('添付を確認', { attachments: [
      { name: 'image.png', path: imagePath, size: png.length, mediaType: 'image/png' },
      { name: 'document.pdf', path: pdfPath, size: pdf.length, mediaType: 'application/pdf' },
    ] })).toEqual({ text: '添付を確認', status: 'done' })
    expect(recorded()[0]?.content).toEqual([
      { type: 'text', text: '添付を確認' },
      { type: 'text', text: '添付 "image.png"' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png.toString('base64') } },
    ])
  })

  it('keeps the process, and so the prompt cache, across a read-only turn', async () => {
    const { run, recorded } = setup()
    expect(await run('first')).toEqual({ text: 'first', status: 'done' })
    expect(await run('second')).toEqual({ text: 'second', status: 'done' })
    expect(await run('review', { access: 'read' })).toEqual({ text: 'review', status: 'done' })

    const [first, second, review] = recorded()
    expect(second!.pid).toBe(first!.pid)
    expect(review!.pid).toBe(first!.pid)
    expect(review!.args).not.toContain('--tools')
  })

  it('refuses a connector change on a read-only turn in the same process that wrote just before', async () => {
    const { run, recorded } = setup()
    await run('first')
    expect(await run('mcp', { access: 'read', approval: 'auto' })).toEqual({ text: 'edit', status: 'done' })
    const [first, mcp, control] = recorded()
    expect(mcp!.pid).toBe(first!.pid)
    expect(mcp!.args).toEqual(expect.arrayContaining(['--settings']))
    expect(control).toMatchObject({ control: { behavior: 'deny', message: expect.stringContaining('読み取り専用') } })
  })

  it('denies a change asked for on a read-only turn', async () => {
    const { run, recorded } = setup()
    expect(await run('edit', { access: 'read', approval: 'auto' })).toEqual({ text: 'edit', status: 'done' })
    expect(recorded()[1]).toMatchObject({ control: { behavior: 'deny', message: 'このターンは読み取り専用です。' } })
  })

  it('refreshes a live 1-hour cache and compacts the same transcript only once before the next message', async () => {
    const advance = clock()
    const { run, recorded, onTool } = setup()
    await run('large')
    await advance(10 * MINUTE)
    await run('cache hit')
    await advance(10 * MINUTE)
    expect(recorded().map((entry) => entry.prompt)).toEqual(['large', 'cache hit'])

    await advance(5 * MINUTE)
    await waitUntil(() => recorded().some((entry) => entry.prompt === '/compact'))
    expect(await run('back from break')).toEqual({ text: 'back from break', status: 'done' })
    expect(recorded().map((entry) => entry.prompt)).toEqual(['large', 'cache hit', '/compact', 'back from break'])
    expect(new Set(recorded().map((entry) => entry.pid)).size).toBe(1)
    expect(onTool).toHaveBeenCalledWith(expect.objectContaining({ status: 'done', title: expect.stringContaining('圧縮') }))
  })

  it.each([
    ['short', 0, false],
    ['five minutes', 0, false],
    ['large', 0, '{"idleCompaction":false}'],
    ['large', 0, '{"env":{"DISABLE_COMPACT":"1"}}'],
    ['large', 0, '{"env":{"DISABLE_AUTO_COMPACT":"true"}}'],
  ] as const)('skips idle compaction for %s with sleep=%s and opt-out=%s', async (prompt, asleep, optOut) => {
    const advance = clock()
    const { run, recorded, directory } = setup()
    await run(prompt)
    if (optOut) writeFileSync(path.join(directory, 'settings.json'), optOut)
    await advance(55 * MINUTE, asleep)
    await run('follow-up')
    expect(recorded().map((entry) => entry.prompt)).toEqual([prompt, 'follow-up'])
  })

  it('compacts first when coming back after the Mac slept past the cache', async () => {
    const advance = clock()
    const { run, recorded, onTool } = setup()
    await run('large')
    await advance(2 * MINUTE, 9 * 60 * MINUTE)
    await advance(20 * MINUTE)
    expect(recorded().map((entry) => entry.prompt)).toEqual(['large'])
    expect(await run('good morning')).toEqual({ text: 'good morning', status: 'done' })
    expect(recorded().map((entry) => entry.prompt)).toEqual(['large', '/compact', 'good morning'])
    expect(new Set(recorded().map((entry) => entry.pid)).size).toBe(1)
    expect(onTool).toHaveBeenCalledWith(expect.objectContaining({ title: 'Claudeの会話を圧縮してから再開しました' }))
  })

  it('compacts first in a new process when the old one closed with a large expired cache', async () => {
    const advance = clock()
    const { run, recorded } = setup()
    await run('large')
    await advance(65 * MINUTE, 10 * MINUTE)
    await run('next')
    expect(recorded().map((entry) => entry.prompt)).toEqual(['large', '/compact', 'next'])
    expect(recorded()[1]!.pid).not.toBe(recorded()[0]!.pid)
    expect(recorded()[2]!.pid).toBe(recorded()[1]!.pid)
    expect(recorded()[1]!.session).toBe(recorded()[0]!.session)
  })

  it('compacts an existing large thread first after AgentSync restarts, reading Claude Code\'s transcript', async () => {
    const { run, recorded, transcript } = setup()
    transcript('old-thread', '2026-11-18T14:48:00.000Z', 520000)
    expect(await run('good morning', { sessionId: 'old-thread' })).toEqual({ text: 'good morning', status: 'done' })
    expect(recorded().map((entry) => [entry.prompt, entry.session])).toEqual([['/compact', 'old-thread'], ['good morning', 'old-thread']])
  })

  it('leaves a small or recent thread as it is after AgentSync restarts', async () => {
    const { run, recorded, transcript } = setup()
    transcript('small', '2026-11-18T14:48:00.000Z', 50000)
    transcript('recent', new Date().toISOString(), 520000)
    await run('a', { sessionId: 'small' })
    await run('b', { sessionId: 'recent' })
    expect(recorded().map((entry) => entry.prompt)).toEqual(['a', 'b'])
  })

  it('stops the compaction itself when the user stops while it runs, sending nothing more', async () => {
    const { run, recorded, transcript, onTool } = setup()
    transcript('old-thread', '2026-11-18T14:48:00.000Z', 520000)
    const controller = new AbortController()
    const current = run('good morning', { sessionId: 'old-thread', signal: controller.signal })
    await waitUntil(() => recorded().length === 1)
    controller.abort()
    expect(await current).toEqual({ text: '', status: 'stopped' })
    await new Promise((resolve) => realSetTimeout(resolve, 300))
    expect(recorded().map((entry) => entry.prompt)).toEqual(['/compact'])
    expect(onTool).not.toHaveBeenCalled()
    expect(await run('again', { sessionId: 'old-thread' })).toEqual({ text: 'again', status: 'done' })
    expect(recorded().map((entry) => entry.prompt)).toEqual(['/compact', '/compact', 'again'])
    expect(recorded()[1]!.pid).not.toBe(recorded()[0]!.pid)
    expect(recorded()[2]!.pid).toBe(recorded()[1]!.pid)
  })

  it('sends the message once in a new process when the CLI does not compact', async () => {
    const { run, recorded, transcript, directory, onTool } = setup()
    writeFileSync(path.join(directory, 'no-compact'), '')
    transcript('old-thread', '2026-11-18T14:48:00.000Z', 520000)
    expect(await run('good morning', { sessionId: 'old-thread' })).toEqual({ text: 'good morning', status: 'done' })
    expect(recorded().map((entry) => entry.prompt)).toEqual(['/compact', 'good morning'])
    expect(recorded()[1]!.pid).not.toBe(recorded()[0]!.pid)
    expect(recorded()[1]!.session).toBe('old-thread')
    expect(onTool).not.toHaveBeenCalled()
    await run('next', { sessionId: 'old-thread' })
    expect(recorded().map((entry) => entry.prompt)).toEqual(['/compact', 'good morning', 'next'])
  })

  it('does not compact on return when compaction is turned off', async () => {
    const advance = clock()
    const { run, recorded, directory } = setup()
    await run('large')
    writeFileSync(path.join(directory, 'settings.json'), '{"idleCompaction":false}')
    await advance(2 * MINUTE, 9 * 60 * MINUTE)
    await run('good morning')
    expect(recorded().map((entry) => entry.prompt)).toEqual(['large', 'good morning'])
  })

  it('still supports an old CLI that ends a turn without echoing the input UUID', async () => {
    const { run, recorded } = setup()
    await run('legacy')
    await run('next')
    expect(recorded()[1]!.pid).not.toBe(recorded()[0]!.pid)
    expect(recorded()[1]!.session).toBe(recorded()[0]!.session)
  })

  it('interrupts a running reply like Esc, keeping the process and its prompt cache', async () => {
    const { run, recorded } = setup()
    const controller = new AbortController()
    const current = run('hang', { signal: controller.signal })
    await waitUntil(() => recorded().length === 1)
    controller.abort()
    expect(await current).toEqual({ text: '途中', status: 'stopped' })
    expect(await run('next')).toEqual({ text: 'next', status: 'done' })
    const [first, interrupt, next] = recorded()
    expect(interrupt).toMatchObject({ interrupt: true, pid: first!.pid })
    expect(next!.pid).toBe(first!.pid)
  })

  it('closes the process when the CLI does not answer an interrupt, then resumes the session', async () => {
    const advance = clock()
    const { run, recorded } = setup()
    const controller = new AbortController()
    const current = run('stuck', { signal: controller.signal })
    await waitUntil(() => recorded().length === 1)
    controller.abort()
    await waitUntil(() => recorded().length === 2)
    await advance(10_000)
    expect(await current).toEqual({ text: '', status: 'stopped' })
    expect(await run('next')).toEqual({ text: 'next', status: 'done' })
    expect(recorded()[2]!.pid).not.toBe(recorded()[0]!.pid)
    expect(recorded()[2]!.session).toBe(recorded()[0]!.session)
  })
})
