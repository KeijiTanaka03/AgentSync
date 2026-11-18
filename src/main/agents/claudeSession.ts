import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import type { ToolLogEntry } from '../../shared/types'
import { ClaudeStreamParser, type ClaudeStreamEvent } from './claudeStream'
import type { AgentRunRequest, AgentRunResult } from './types'

const MINUTE = 60_000
const IDLE_COMPACT_DELAY = 55 * MINUTE
const CACHE_TTL = 60 * MINUTE
const IDLE_PROCESS_LIMIT = 65 * MINUTE
const COMPACT_TIMEOUT = 2 * MINUTE
const STDERR_LIMIT = 8_000

type Json = Record<string, unknown>
type Result = Extract<ClaudeStreamEvent, { kind: 'result' }>

interface SessionOptions {
  binary: string
  args: string[]
  cwd: string
  env: NodeJS.ProcessEnv
  sessionId: string | null
  key: string
  approve(request: AgentRunRequest, tool: string, input: Json): Promise<true | string>
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
  stop(): void
  outcome?: Result
  sawInput?: boolean
  compacted?: boolean
}

function settingsObject(value: unknown): Json {
  return value && typeof value === 'object' ? (value as Json) : {}
}

/** Honor explicit opt-outs in the CLI's local settings before sending a background command. */
function idleCompactMinimum(cwd: string, env: NodeJS.ProcessEnv): number | null {
  const config = env.CLAUDE_CONFIG_DIR || path.join(homedir(), '.claude')
  const files = [
    path.join(config, 'settings.json'),
    path.join(cwd, '.claude', 'settings.json'),
    path.join(cwd, '.claude', 'settings.local.json'),
    process.platform === 'win32'
      ? path.join(env.ProgramFiles ?? 'C:\\Program Files', 'ClaudeCode', 'managed-settings.json')
      : process.platform === 'darwin'
        ? '/Library/Application Support/ClaudeCode/managed-settings.json'
        : '/etc/claude-code/managed-settings.json',
  ]
  let minimum: unknown = env.CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS
  if (env.DISABLE_AUTO_COMPACT === '1') return null
  for (const file of files) {
    try {
      const settings = settingsObject(JSON.parse(readFileSync(file, 'utf8')))
      const vars = settingsObject(settings.env)
      if (settings.idleCompaction === false || settings.autoCompactEnabled === false || String(vars.DISABLE_AUTO_COMPACT) === '1') return null
      minimum = vars.CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS ?? minimum
    } catch {
      // An absent or invalid settings file contributes no settings.
    }
  }
  const value = Number(minimum)
  return Number.isSafeInteger(value) && value > 0 ? Math.max(100_000, value) : 200_000
}

/** Owns the streaming input and output of one live Claude Code session. */
export class ClaudeSession {
  private readonly child
  private readonly closed: Promise<void>
  private readonly idleParser = new ClaudeStreamParser()
  private turn: Turn | null = null
  private closing = false
  private retiring = false
  private stderr = ''
  private spawnError: Error | null = null
  private canCompact = false
  private backgroundTasks = false
  private cache: { tokens: number; at: number } | null = null
  private compactTimer?: ReturnType<typeof setTimeout>
  private expireTimer?: ReturnType<typeof setTimeout>

  sessionId: string | null

  constructor(private readonly options: SessionOptions) {
    this.sessionId = options.sessionId
    const child = spawn(options.binary, options.args, { cwd: options.cwd, env: options.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
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

  run(request: AgentRunRequest): Promise<AgentRunResult> {
    return this.sendTurn(request.prompt, request)
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

  private sendTurn(prompt: string, request: AgentRunRequest | null): Promise<AgentRunResult> {
    if (request?.signal.aborted) return Promise.resolve({ text: '', status: 'stopped' })
    if (this.turn || this.closing || !this.child.stdin.writable) {
      return Promise.reject(new Error('Claude Codeセッションを開始できませんでした'))
    }
    this.clearTimers()
    const id = randomUUID()
    const stop = () => { void this.close() }
    let resolve!: Turn['resolve']
    let reject!: Turn['reject']
    const promise = new Promise<AgentRunResult>((done, fail) => { resolve = done; reject = fail })
    const parser = new ClaudeStreamParser(request?.access === 'chat' ? null : this.options.cwd)
    this.turn = { id, request, parser, promise, resolve, reject, stop }
    request?.signal.addEventListener('abort', stop, { once: true })
    this.send({ type: 'user', uuid: id, parent_tool_use_id: null, message: { role: 'user', content: prompt } })
    return promise
  }

  private send(message: Json): void {
    if (this.child.stdin.writable && !this.closing) this.child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  private takeTurn(): Turn | null {
    const turn = this.turn
    this.turn = null
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
    const turn = this.turn
    const events = (turn?.parser ?? this.idleParser).push(line, turn?.id, !turn)
    for (const event of events) {
      if (event.kind === 'control') {
        void this.answer(turn, event.requestId, event.request)
      } else if (event.kind === 'commands') {
        this.canCompact = event.canCompact
      } else if (event.kind === 'background') {
        this.backgroundTasks = event.running
      } else if (event.kind === 'compacted') {
        if (turn) turn.compacted = true
        this.cache = null
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
          turn.sawInput = true
          const at = Date.now() - event.ttftMs
          const previous = this.cache && at < this.cache.at + CACHE_TTL ? this.cache.tokens : 0
          // Confirm the 1-hour write from a real model request. A hit can refresh that prefix.
          this.cache = { at, tokens: event.writtenForHour + Math.min(event.read, previous) }
        }
        break
      case 'result': this.finish(turn, event); break
    }
  }

  private finish(turn: Turn, result: Result): void {
    if (!turn.request && !result.matched) return
    const compacted = !turn.request && result.command === 'compact' && turn.compacted
    if (!turn.request && !compacted) {
      this.takeTurn()
      turn.reject(new Error('Claude Codeが圧縮を完了しませんでした'))
      void this.close()
      return
    }
    if (!result.ok || !result.matched || !this.sessionId || this.retiring || this.backgroundTasks || this.child.stdin.writableEnded) {
      // Older CLIs and ongoing background tasks use the original one-shot exit behaviour.
      turn.outcome = result
      this.child.stdin.end()
      return
    }
    this.takeTurn()
    this.expireTimer = setTimeout(() => { void this.close() }, IDLE_PROCESS_LIMIT)
    this.expireTimer.unref()
    if (turn.sawInput && turn.request) this.scheduleCompaction(turn.request.onTool)
    turn.resolve({ text: result.text, status: 'done' })
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

  private async compact(report: (tool: ToolLogEntry) => void): Promise<void> {
    const timeout = setTimeout(() => { void this.close() }, COMPACT_TIMEOUT)
    timeout.unref()
    try {
      await this.sendTurn('/compact', null)
      report({ id: randomUUID(), kind: 'other', title: '離席中にClaudeの会話を圧縮しました', status: 'done' })
    } catch {
      // Leave the transcript to Claude. Never retry a compaction automatically.
    } finally {
      clearTimeout(timeout)
    }
  }

  private async answer(turn: Turn | null, id: string, body: Json): Promise<void> {
    if (body.subtype !== 'can_use_tool' || typeof body.tool_name !== 'string') {
      this.send({ type: 'control_response', response: { subtype: 'error', request_id: id, error: 'AgentSync はこの要求に対応していません' } })
      return
    }
    const denied = 'この操作は許可されていません。'
    let decision: true | string = denied
    const input = settingsObject(body.input)
    if (turn?.request && !turn.request.signal.aborted) {
      try { decision = await this.options.approve(turn.request, body.tool_name, input) } catch { /* deny */ }
    }
    const response = decision === true && this.turn === turn && !turn?.request?.signal.aborted
      ? { behavior: 'allow', updatedInput: input }
      : { behavior: 'deny', message: decision === true ? denied : decision }
    this.send({ type: 'control_response', response: { subtype: 'success', request_id: id, response } })
  }
}
