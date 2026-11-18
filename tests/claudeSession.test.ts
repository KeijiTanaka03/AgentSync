import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const input = JSON.parse(line)
  if (input.type !== 'user') return
  const prompt = input.message.content
  record({ prompt, pid: process.pid, args, session })
  response({ type: 'system', subtype: 'init', session_id: session, model: 'opus', slash_commands: ['compact'] })
  const result = { type: 'result', subtype: 'success', session_id: session, result: prompt }
  if (prompt !== 'legacy') result.user_message_uuid = input.uuid
  if (prompt === '/compact') {
    setTimeout(() => {
      response({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'manual', pre_tokens: 300000 } })
      response({ ...result, local_command: 'compact' })
    }, 120)
    return
  }
  if (prompt === 'hang') return
  const read = prompt === 'cache hit' ? 290000 : 0
  const forHour = prompt === 'large' ? 300000 : prompt === 'short' ? 50000 : 0
  const forFiveMinutes = prompt === 'five minutes' ? 300000 : 0
  response({ type: 'stream_event', event: { type: 'message_start', message: { usage: {
    cache_read_input_tokens: read,
    cache_creation_input_tokens: forHour + forFiveMinutes,
    cache_creation: { ephemeral_1h_input_tokens: forHour, ephemeral_5m_input_tokens: forFiveMinutes },
  } } } })
  response(result)
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
  const recorded = (): { prompt: string; pid: number; args: string[]; session: string }[] =>
    existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []
  return { run, recorded, adapter, onTool, directory, sessionId: () => sessionId }
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
  it('reuses the process for a follow-up and resumes with fresh read-only arguments when access changes', async () => {
    const { run, recorded } = setup()
    expect(await run('first')).toEqual({ text: 'first', status: 'done' })
    expect(await run('second')).toEqual({ text: 'second', status: 'done' })
    expect(await run('review', { access: 'read' })).toEqual({ text: 'review', status: 'done' })

    const [first, second, review] = recorded()
    expect(second!.pid).toBe(first!.pid)
    expect(review!.pid).not.toBe(first!.pid)
    expect(review!.session).toBe(first!.session)
    expect(review!.args).toEqual(expect.arrayContaining(['--resume', first!.session, '--tools', 'Read,Glob,Grep,WebSearch,WebFetch']))
    expect(review!.args).not.toContain('bypassPermissions')
  })

  it('refreshes a live 1-hour cache and compacts the same transcript only once before the next message', async () => {
    const advance = clock()
    const { run, recorded, onTool } = setup()
    await run('large')
    await advance(20 * MINUTE)
    await run('cache hit')
    await advance(35 * MINUTE)
    expect(recorded().map((entry) => entry.prompt)).toEqual(['large', 'cache hit'])

    await advance(20 * MINUTE)
    await waitUntil(() => recorded().some((entry) => entry.prompt === '/compact'))
    expect(await run('back from break')).toEqual({ text: 'back from break', status: 'done' })
    expect(recorded().map((entry) => entry.prompt)).toEqual(['large', 'cache hit', '/compact', 'back from break'])
    expect(new Set(recorded().map((entry) => entry.pid)).size).toBe(1)
    expect(onTool).toHaveBeenCalledWith(expect.objectContaining({ status: 'done', title: expect.stringContaining('圧縮') }))
  })

  it.each([
    ['short', 0, false],
    ['five minutes', 0, false],
    ['large', 10 * MINUTE, false],
    ['large', 0, true],
  ] as const)('skips idle compaction for %s with sleep=%s and opt-out=%s', async (prompt, asleep, optOut) => {
    const advance = clock()
    const { run, recorded, directory } = setup()
    await run(prompt)
    if (optOut) writeFileSync(path.join(directory, 'settings.json'), '{"idleCompaction":false}')
    await advance(55 * MINUTE, asleep)
    await run('follow-up')
    expect(recorded().map((entry) => entry.prompt)).toEqual([prompt, 'follow-up'])
  })

  it('still supports an old CLI that ends a turn without echoing the input UUID', async () => {
    const { run, recorded } = setup()
    await run('legacy')
    await run('next')
    expect(recorded()[1]!.pid).not.toBe(recorded()[0]!.pid)
    expect(recorded()[1]!.session).toBe(recorded()[0]!.session)
  })

  it('stops a running reply and resumes the saved session in a fresh process', async () => {
    const { run, recorded } = setup()
    const controller = new AbortController()
    const current = run('hang', { signal: controller.signal })
    await waitUntil(() => recorded().length === 1)
    controller.abort()
    expect(await current).toEqual({ text: '', status: 'stopped' })
    expect(await run('next')).toEqual({ text: 'next', status: 'done' })
    expect(recorded()[1]!.pid).not.toBe(recorded()[0]!.pid)
  })

  it('cancels an idle timer when the session is stopped', async () => {
    const advance = clock()
    const { run, recorded, adapter, sessionId } = setup()
    await run('large')
    adapter.closeSession(sessionId()!)
    await advance(55 * MINUTE)
    await run('follow-up')
    expect(recorded().map((entry) => entry.prompt)).toEqual(['large', 'follow-up'])
    expect(recorded()[1]!.pid).not.toBe(recorded()[0]!.pid)
  })
})
