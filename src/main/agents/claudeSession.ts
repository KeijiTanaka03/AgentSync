import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { open, readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import type { TokenUsage, ToolLogEntry } from '../../shared/types'
import { ClaudeStreamParser, parseClaudeModelUsage, type ClaudeStreamEvent } from './claudeStream'
import { tokenUsageDelta, ZERO_TOKENS } from './tokenUsage'
import type { AgentAttachment, AgentRunRequest, AgentRunResult } from './types'

const MINUTE = 60_000
/** Claude Code prepares its summary while the cache is still warm; -p cannot swap later, so compact then. */
const IDLE_COMPACT_DELAY = 15 * MINUTE
const CACHE_TTL = 60 * MINUTE
const IDLE_PROCESS_LIMIT = 65 * MINUTE
const COMPACT_TIMEOUT = 2 * MINUTE
const INTERRUPT_TIMEOUT = 10_000
const STDERR_LIMIT = 8_000

type Json = Record<string, unknown>
type Result = Extract<ClaudeStreamEvent, { kind: 'result' }>
export type CacheState = { tokens: number; at: number }

interface SessionOptions {
  binary: string
  args: string[]
  cwd: string
  env: NodeJS.ProcessEnv
  sessionId: string | null
  key: string
  /** What the last process of this session left in the prompt cache, to compact on return. */
  cache?: CacheState | null
  /** The counters Claude Code restores from the same transcript on resume. */
  totalTokenUsage?: TokenUsage
  onCache?(cache: CacheState | null): void
  /** `connectors`: where each connector of this process comes from, by tool prefix, as it reported at start. */
  approve(request: AgentRunRequest, tool: string, input: Json, connectors: ReadonlyMap<string, string>): Promise<true | string | { input: Json }>
  onSession(id: string, previous: string | null): void
  onClose(): void
}

interface Turn {
  id: string
  request: AgentRunRequest | null
  parser: ClaudeStreamParser
  promise: Promise<AgentRunResult>
  resolve(result: AgentRunResult): void
  reject(error: Error): void
  onUsage?: AgentRunRequest['onUsage']
  stop(): void
  outcome?: Result
  sawInput?: boolean
  compacted?: boolean
  interruptTimer?: ReturnType<typeof setTimeout>
  followups?: Map<string, (accepted: boolean) => void>
}

function settingsObject(value: unknown): Json {
  return value && typeof value === 'object' ? (value as Json) : {}
}

/** How Claude Code reads an on/off environment variable. */
function isOn(value: unknown): boolean {
  return ['1', 'true', 'yes', 'on'].includes(String(value ?? '').trim().toLowerCase())
}

/** Honor explicit opt-outs in the CLI's local settings before sending a background command. */
function idleCompactMinimum(cwd: string, env: NodeJS.ProcessEnv): number | null {
  const config = env.CLAUDE_CONFIG_DIR || path.join(homedir(), '.claude')
  const files = [
    path.join(config, 'settings.json'),
    path.join(cwd, '.claude', 'settings.json'),
    path.join(cwd, '.claude', 'settings.local.json'),
    process.platform === 'darwin'
      ? '/Library/Application Support/ClaudeCode/managed-settings.json'
      : '/etc/claude-code/managed-settings.json',
  ]
  let minimum: unknown = env.CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS
  if (isOn(env.DISABLE_COMPACT) || isOn(env.DISABLE_AUTO_COMPACT)) return null
  for (const file of files) {
    try {
      const settings = settingsObject(JSON.parse(readFileSync(file, 'utf8')))
      const vars = settingsObject(settings.env)
      if (settings.idleCompaction === false || settings.autoCompactEnabled === false || isOn(vars.DISABLE_COMPACT) || isOn(vars.DISABLE_AUTO_COMPACT)) return null
      minimum = vars.CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS ?? minimum
    } catch {
      // An absent or invalid settings file contributes no settings.
    }
  }
  const value = Number(minimum)
  return Number.isSafeInteger(value) && value > 0 ? Math.max(100_000, value) : 200_000
}

/**
 * Read the last prompt size and cumulative usage from Claude Code's transcript.
 * A compaction boundary clears the prompt size but the usage totals carry over.
 */
export async function transcriptState(env: NodeJS.ProcessEnv, sessionId: string): Promise<{ cache: CacheState | null; totalTokenUsage?: TokenUsage } | null> {
  const projects = path.join(env.CLAUDE_CONFIG_DIR || path.join(homedir(), '.claude'), 'projects')
  const folders = await readdir(projects).catch(() => [] as string[])
  for (const folder of folders) {
    const file = await open(path.join(projects, folder, `${sessionId}.jsonl`), 'r').catch(() => null)
    if (!file) continue
    try {
      const { size } = await file.stat()
      const length = Math.min(size, 8 * 1024 * 1024)
      const buffer = Buffer.alloc(length)
      await file.read(buffer, 0, length, size - length)
      const lines = buffer.toString('utf8').split('\n')
      if (length < size) lines.shift()
      let cache: CacheState | null | undefined
      let totalTokenUsage: TokenUsage | undefined
      for (const line of lines.reverse()) {
        let entry: Json
        try { entry = settingsObject(JSON.parse(line)) } catch { continue }
        if (entry.type === 'cost-state' && !totalTokenUsage) totalTokenUsage = parseClaudeModelUsage(entry.modelUsage)
        if (cache === undefined) {
          if (entry.type === 'system' && entry.subtype === 'compact_boundary') cache = null
          else if (entry.type === 'assistant' && !entry.isSidechain) {
            const usage = settingsObject(settingsObject(entry.message).usage)
            if ('cache_read_input_tokens' in usage) {
              const at = Date.parse(String(entry.timestamp))
              const tokens = ['input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'].reduce((sum, key) => sum + (Number(usage[key]) || 0), 0)
              cache = Number.isFinite(at) ? { tokens, at } : null
            }
          }
        }
        if (cache !== undefined && totalTokenUsage) break
      }
      return { cache: cache ?? null, totalTokenUsage }
    } finally {
      await file.close()
    }
  }
  return null
}

/**
 * A user message as Claude Code builds it: images go in as images; other files are named by their path in
 * the text (formatUnseen lists them), for Claude to read with its own tools.
 */
async function userContent(text: string, attachments: AgentAttachment[] | undefined, signal: AbortSignal): Promise<string | Json[]> {
  const content: Json[] = [{ type: 'text', text }]
  let remaining = 12 * 1024 * 1024
  for (const file of attachments ?? []) {
    const mediaType = file.mediaType
    if (!mediaType?.startsWith('image/') || signal.aborted) continue
    const limit = Math.min(remaining, 4 * 1024 * 1024)
    if (file.size > limit) continue
    const bytes = await readFile(file.path).catch(() => null)
    if (!bytes?.length || bytes.length > limit) continue
    remaining -= bytes.length
    content.push({ type: 'text', text: `添付 ${JSON.stringify(file.name)}` }, { type: 'image', source: { type: 'base64', media_type: mediaType, data: bytes.toString('base64') } })
  }
  return content.length > 1 ? content : text
}

export class ClaudeSession {
  private readonly child
  private readonly closed: Promise<void>
  private readonly idleParser = new ClaudeStreamParser()
  private turn: Turn | null = null
  private closing = false
  private retiring = false
  private stderr = ''
  private spawnError: Error | null = null
  /** Unknown until the CLI lists its commands; a resumed CLI is tried, and closed if it cannot. */
  private canCompact: boolean | null = null
  private backgroundTasks = false
  private cache: CacheState | null
  private totalTokenUsage?: TokenUsage
  private compactTimer?: ReturnType<typeof setTimeout>
  private expireTimer?: ReturnType<typeof setTimeout>

  sessionId: string | null
  private readonly connectors = new Map<string, string>()

  constructor(private readonly options: SessionOptions) {
    this.sessionId = options.sessionId
    this.cache = options.cache ?? null
    this.totalTokenUsage = options.sessionId ? options.totalTokenUsage : ZERO_TOKENS
    const child = spawn(options.binary, options.args, { cwd: options.cwd, env: options.env, stdio: ['pipe', 'pipe', 'pipe'] })
    this.child = child
    child.once('error', (error) => { this.spawnError = error })
    child.stdin.on('error', () => { void this.close() })
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-STDERR_LIMIT)
    })
    readline.createInterface({ input: child.stdout }).on('line', (line) => this.onLine(line))
    this.closed = new Promise((resolve) => child.once('close', (code) => {
      this.closing = true
      this.clearTimers()
      const turn = this.takeTurn()
      if (turn) {
        if (turn.request?.signal.aborted) turn.resolve({ text: turn.parser.text, status: 'stopped' })
        else if (turn.outcome?.ok) turn.resolve({ text: turn.outcome.text, status: 'done' })
        else if (turn.outcome) turn.reject(new Error(turn.outcome.error))
        else if (this.spawnError) turn.reject(new Error(`Claude Code CLI を起動できませんでした: ${this.spawnError.message}`))
        else turn.reject(new Error(`Claude Code CLI が応答せずに終了しました: ${this.stderr.trim() || `終了コード ${code}`}`))
      }
      options.onClose()
      resolve()
    }))
  }

  matches(key: string): boolean {
    return key === this.options.key && !this.closing && !this.retiring && !this.backgroundTasks && this.child.stdin.writable
  }

  /** If an idle compaction has already started, let it finish before sending the new prompt. */
  async waitForTurn(request: AgentRunRequest): Promise<void> {
    this.clearTimers()
    if (this.closing) return this.closed
    const turn = this.turn
    if (!turn || request.signal.aborted) return
    if (turn.request) throw new Error('このClaude Codeセッションは実行中です')
    request.onActivity({ kind: 'working', detail: 'Claudeの会話履歴を圧縮中' })
    await new Promise<void>((resolve) => {
      const done = () => {
        request.signal.removeEventListener('abort', done)
        resolve()
      }
      request.signal.addEventListener('abort', done, { once: true })
      void turn.promise.then(done, done)
    })
  }

  async run(request: AgentRunRequest): Promise<AgentRunResult> {
    return this.sendTurn(await userContent(request.prompt, request.attachments, request.signal), request)
  }

  /**
   * Back after the prompt cache expired (the Mac slept, or the process was closed): compact a large
   * conversation first, as Claude Code does on return, rather than write it all to the cache again.
   */
  async compactOnReturn(request: AgentRunRequest): Promise<void> {
    const cache = this.cache
    if (!cache || this.turn || this.closing || this.retiring || this.backgroundTasks || this.canCompact === false) return
    if (Date.now() < cache.at + CACHE_TTL || request.signal.aborted) return
    const minimum = idleCompactMinimum(this.options.cwd, this.options.env)
    if (minimum === null || cache.tokens < minimum) {
      this.setCache(null)
      return
    }
    request.onActivity({ kind: 'working', detail: 'Claudeの会話履歴を圧縮中' })
    // A stop ends the compaction too: the process closes, and the next message waits for that.
    const stop = () => { void this.close() }
    request.signal.addEventListener('abort', stop, { once: true })
    try {
      await this.compact(request.onTool, 'Claudeの会話を圧縮してから再開しました', request.signal)
    } finally {
      request.signal.removeEventListener('abort', stop)
      // A compaction clears the size itself. Keep it after a stop, to compact on the next message; a CLI
      // that did not compact is not asked again.
      if (!request.signal.aborted && this.cache === cache) this.setCache(null)
    }
  }

  retire(): void {
    this.retiring = true
    this.clearTimers()
    if (!this.turn?.request) void this.close()
  }

  close(): Promise<void> {
    if (!this.closing) {
      this.closing = true
      this.clearTimers()
      this.child.kill('SIGTERM')
      const force = setTimeout(() => { this.child.kill('SIGKILL') }, 3_000)
      force.unref()
      void this.closed.then(() => clearTimeout(force))
    }
    return this.closed
  }

  private sendTurn(prompt: string | Json[], request: AgentRunRequest | null, onUsage = request?.onUsage): Promise<AgentRunResult> {
    if (request?.signal.aborted) return Promise.resolve({ text: '', status: 'stopped' })
    if (this.turn || this.closing || !this.child.stdin.writable) {
      return Promise.reject(new Error('Claude Codeセッションを開始できませんでした'))
    }
    this.clearTimers()
    const id = randomUUID()
    let resolve!: Turn['resolve']
    let reject!: Turn['reject']
    const promise = new Promise<AgentRunResult>((done, fail) => { resolve = done; reject = fail })
    const parser = new ClaudeStreamParser(request?.access === 'chat' ? null : this.options.cwd)
    const turn: Turn = {
      id, request: request && { ...request, attachments: [...(request.attachments ?? [])] },
      parser, promise, resolve, reject, onUsage, stop: () => this.interrupt(turn),
    }
    this.turn = turn
    const { stop } = turn
    request?.signal.addEventListener('abort', stop, { once: true })
    this.send({ type: 'user', uuid: id, parent_tool_use_id: null, message: { role: 'user', content: prompt } })
    return promise
  }

  /**
   * Claude Code says at start where each connector comes from (`claudeai` for claude.ai's). Kept by the
   * prefix its tools carry: 「claude.ai Notion」 → `claude_ai_Notion`.
   */
  private noteConnectors(line: string): void {
    if (!line.includes('"subtype":"init"')) return
    let data: unknown
    try { data = JSON.parse(line) } catch { return }
    const init = data as { type?: unknown; subtype?: unknown; mcp_servers?: unknown }
    if (init.type !== 'system' || init.subtype !== 'init' || !Array.isArray(init.mcp_servers)) return
    this.connectors.clear()
    for (const server of init.mcp_servers as { name?: unknown; source?: unknown }[]) {
      if (typeof server.name === 'string' && typeof server.source === 'string') this.connectors.set(server.name.replace(/[^\w-]/g, '_'), server.source)
    }
  }

  private send(message: Json): void {
    if (this.child.stdin.writable && !this.closing) this.child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  /** Stops the turn the way Esc does in the terminal: the process, and so the prompt cache, stays. */
  private interrupt(turn: Turn): void {
    if (this.turn !== turn || this.closing || turn.interruptTimer) return
    // Input the CLI may still hold in its queue would start a turn of its own; close instead.
    if (turn.followups?.size || !this.child.stdin.writable) {
      void this.close()
      return
    }
    turn.interruptTimer = setTimeout(() => { void this.close() }, INTERRUPT_TIMEOUT)
    turn.interruptTimer.unref()
    this.send({ type: 'control_request', request_id: randomUUID(), request: { subtype: 'interrupt' } })
  }

  private takeTurn(): Turn | null {
    const turn = this.turn
    this.turn = null
    clearTimeout(turn?.interruptTimer)
    for (const settle of turn?.followups?.values() ?? []) settle(false)
    turn?.request?.signal.removeEventListener('abort', turn.stop)
    return turn
  }

  private clearTimers(): void {
    clearTimeout(this.compactTimer)
    clearTimeout(this.expireTimer)
    this.compactTimer = this.expireTimer = undefined
  }

  private onLine(line: string): void {
    if (this.closing) return
    this.noteConnectors(line)
    const turn = this.turn
    const events = (turn?.parser ?? this.idleParser).push(line, turn?.id, !turn, turn?.followups)
    for (const event of events) {
      if (event.kind === 'control') {
        void this.answer(turn, event.requestId, event.request)
      } else if (event.kind === 'commands') {
        this.canCompact = event.canCompact
      } else if (event.kind === 'background') {
        this.backgroundTasks = event.running
      } else if (event.kind === 'compacted') {
        if (turn) turn.compacted = true
        this.setCache(null)
      } else if (turn) {
        this.onTurnEvent(turn, event)
      }
    }
  }

  private onTurnEvent(turn: Turn, event: ClaudeStreamEvent): void {
    const { request } = turn
    switch (event.kind) {
      case 'session': {
        if (request && event.sessionId !== this.sessionId) {
          this.options.onSession(event.sessionId, this.sessionId)
          this.sessionId = event.sessionId
          this.totalTokenUsage = ZERO_TOKENS
        }
        request?.onSession(event.sessionId)
        break
      }
      case 'model': request?.onModel(event.model); break
      case 'activity': request?.onActivity(event.activity); break
      case 'text': request?.onText(event.text); break
      case 'tool': request?.onTool(event.tool); break
      case 'cache':
        if (request) {
          if (!turn.sawInput && request.onSteer) {
            turn.followups = new Map()
            request.onSteer(async (text, attachments) => {
              const content = await userContent(text, attachments, request.signal)
              if (this.turn !== turn || this.closing || this.retiring || request.signal.aborted || !this.child.stdin.writable) return false
              const uuid = randomUUID()
              request.attachments?.push(...(attachments ?? []))
              return new Promise<boolean>((resolve) => {
                turn.followups!.set(uuid, resolve)
                this.send({ type: 'user', uuid, priority: 'next', parent_tool_use_id: null, message: { role: 'user', content } })
              })
            })
          }
          turn.sawInput = true
          const at = Date.now() - event.ttftMs
          const previous = this.cache && at < this.cache.at + CACHE_TTL ? this.cache.tokens : 0
          // Confirm the 1-hour write from a real model request. A hit can refresh that prefix.
          this.setCache({ at, tokens: event.writtenForHour + Math.min(event.read, previous) })
        }
        break
      case 'result': this.finish(turn, event); break
    }
  }

  private finish(turn: Turn, result: Result): void {
    if (!turn.request && !result.matched) return
    const { tokenUsage, totalTokenUsage } = result
    // The per-turn result covers the main loop. A standalone /compact can report zero there
    // even though its model call is counted in the cumulative modelUsage.
    const delta = totalTokenUsage && this.totalTokenUsage ? tokenUsageDelta(totalTokenUsage, this.totalTokenUsage) : undefined
    // A crash result can contain zeroed counters even though the CLI still has its old totals.
    this.totalTokenUsage = result.ok || delta ? totalTokenUsage : undefined
    const used = delta && (!tokenUsage || tokenUsageDelta(delta, tokenUsage)) ? delta : tokenUsage
    if (used && (used.inputTokens > 0 || used.outputTokens > 0)) turn.onUsage?.(used)
    const compacted = !turn.request && result.command === 'compact' && turn.compacted
    if (!turn.request && !compacted) {
      this.takeTurn()
      turn.reject(new Error('Claude Codeが圧縮を完了しませんでした'))
      void this.close()
      return
    }
    for (const id of result.inputIds ?? []) {
      turn.followups?.get(id)?.(true)
      turn.followups?.delete(id)
    }
    if (turn.followups?.size && result.ok) {
      // A prompt can arrive just as the CLI finishes. Close before resending unconfirmed input.
      turn.outcome = result
      void this.close()
      return
    }
    const stopped = Boolean(turn.request?.signal.aborted)
    if ((!result.ok && !stopped) || !result.matched || !this.sessionId || this.retiring || this.backgroundTasks || this.child.stdin.writableEnded) {
      // Older CLIs and ongoing background tasks use the original one-shot exit behaviour.
      turn.outcome = result
      this.child.stdin.end()
      return
    }
    this.takeTurn()
    this.expireTimer = setTimeout(() => { void this.close() }, IDLE_PROCESS_LIMIT)
    this.expireTimer.unref()
    if (turn.sawInput && turn.request) this.scheduleCompaction(turn.request.onTool)
    turn.resolve(result.ok && !stopped ? { text: result.text, status: 'done' } : { text: turn.parser.text, status: 'stopped' })
  }

  private setCache(cache: CacheState | null): void {
    this.cache = cache
    this.options.onCache?.(cache)
  }

  private scheduleCompaction(report: (tool: ToolLogEntry) => void): void {
    const cache = this.cache
    if (!this.canCompact || !cache || cache.tokens < 100_000) return
    const minimum = idleCompactMinimum(this.options.cwd, this.options.env)
    if (minimum === null || cache.tokens < minimum) return
    this.compactTimer = setTimeout(() => {
      if (this.turn || this.closing || this.retiring || this.backgroundTasks) return
      if (Date.now() >= cache.at + CACHE_TTL - COMPACT_TIMEOUT || this.cache !== cache) return
      // Recheck before using quota, in case the user disabled compaction while away.
      const currentMinimum = idleCompactMinimum(this.options.cwd, this.options.env)
      if (currentMinimum === null || cache.tokens < currentMinimum) return
      void this.compact(report)
    }, Math.max(0, cache.at + IDLE_COMPACT_DELAY - Date.now()))
    this.compactTimer.unref()
  }

  private async compact(report: (tool: ToolLogEntry) => void, title = '離席中にClaudeの会話を圧縮しました', signal?: AbortSignal): Promise<void> {
    const timeout = setTimeout(() => { void this.close() }, COMPACT_TIMEOUT)
    timeout.unref()
    let tokenUsage: TokenUsage | undefined
    let completed = false
    try {
      await this.sendTurn('/compact', null, (usage) => { tokenUsage = usage })
      completed = !signal?.aborted
    } catch {
      // Leave the transcript to Claude. Never retry a compaction automatically.
    } finally {
      clearTimeout(timeout)
    }
    if (completed || tokenUsage) report({
      id: randomUUID(),
      kind: 'other',
      title: completed ? title : 'Claudeの会話履歴の圧縮を完了できませんでした',
      status: completed ? 'done' : 'failed',
      ...(tokenUsage ? { tokenUsage } : {}),
    })
  }

  private async answer(turn: Turn | null, id: string, body: Json): Promise<void> {
    if (body.subtype !== 'can_use_tool' || typeof body.tool_name !== 'string') {
      this.send({ type: 'control_response', response: { subtype: 'error', request_id: id, error: 'AgentSync はこの要求に対応していません' } })
      return
    }
    const denied = 'この操作は許可されていません。'
    let decision: true | string | { input: Json } = denied
    const input = settingsObject(body.input)
    if (turn?.request && !turn.request.signal.aborted) {
      try { decision = await this.options.approve(turn.request, body.tool_name, input, this.connectors) } catch { /* deny */ }
    }
    const live = this.turn === turn && !turn?.request?.signal.aborted
    const response =
      typeof decision !== 'string' && live
        ? { behavior: 'allow', updatedInput: decision === true ? input : decision.input }
        : { behavior: 'deny', message: typeof decision === 'string' ? decision : denied }
    this.send({ type: 'control_response', response: { subtype: 'success', request_id: id, response } })
  }
}
