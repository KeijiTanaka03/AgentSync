import { spawn } from 'node:child_process'
import readline from 'node:readline'
import path from 'node:path'
import type { AgentChoices, AgentQuestion, QuestionAnswers } from '../../shared/types'
import type { AgentAdapter, AgentRunRequest, AgentRunResult, ApprovalRequest } from './types'
import { ClaudeSession, transcriptCache, type CacheState } from './claudeSession'
import { describeClaudeTool, isReadOnlyTool, mcpTool } from './claudeStream'
import { isVerifiedClaudeRead } from './connectorReads'

export interface ClaudeAdapterOptions {
  /** Resolves the `claude` executable. */
  resolveBinary(): Promise<string>
  /** Environment for the child process. */
  env(): NodeJS.ProcessEnv
  /** Folder to run in when only asking Claude Code which models it offers (an empty folder). */
  listCwd?: string
}

/** One entry of the model list Claude Code shows in its /model menu. */
export interface ClaudeModelInfo {
  value: string
  resolvedModel?: string
  displayName?: string
  description?: string
  supportsEffort?: boolean
  supportedEffortLevels?: string[]
}

function isModelInfo(value: unknown): value is ClaudeModelInfo {
  return typeof value === 'object' && value !== null && typeof (value as { value?: unknown }).value === 'string'
}

/**
 * Reads the models from the answer to an `initialize` control request (stream-json input).
 * Returns null for any other line. Only `models` is kept from the answer (it also describes the account).
 */
export function parseModelList(line: string): ClaudeModelInfo[] | null {
  let data: unknown
  try {
    data = JSON.parse(line)
  } catch {
    return null
  }
  if (typeof data !== 'object' || data === null || (data as { type?: unknown }).type !== 'control_response') return null
  const response = (data as { response?: { response?: { models?: unknown } } }).response?.response
  return Array.isArray(response?.models) ? response.models.filter(isModelInfo) : []
}

/** The levels `claude --effort` accepts (Claude Code 2.1). Claude Code does not report which one it uses by default. */
export const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']

/** Built-in tools that only read the web; they go ahead without asking. */
const WEB_TOOLS = new Set(['WebSearch', 'WebFetch'])
const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])
/** Built-in tools that only read files. */
const READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS', 'NotebookRead'])
const MAX_DETAIL = 4_000

type Json = Record<string, unknown>

const clip = (text: string) => (text.length > MAX_DETAIL ? `${text.slice(0, MAX_DETAIL)}\n…` : text)

/** What a `can_use_tool` request asks for, as an approval card. */
export function describePermission(toolName: string, input: Json, cwd: string): ApprovalRequest {
  const { kind, title } = describeClaudeTool(toolName, input, cwd)
  if (toolName === 'Bash') return { kind: 'command', title: `コマンドを実行: ${title}`, detail: clip(String(input.command ?? '')) }
  if (EDIT_TOOLS.has(toolName)) {
    const detail =
      typeof input.old_string === 'string'
        ? `- ${input.old_string.split('\n').join('\n- ')}\n+ ${String(input.new_string ?? '').split('\n').join('\n+ ')}`
        : typeof input.content === 'string'
          ? input.content
          : JSON.stringify(input, null, 2)
    return { kind: 'edit', title: `${toolName === 'Write' ? 'ファイルを書く' : 'ファイルを編集'}: ${title}`, detail: clip(detail) }
  }
  return { kind: kind === 'command' ? 'command' : 'other', title: `${toolName} を使う${title && title !== toolName ? `: ${title}` : ''}`, detail: clip(JSON.stringify(input, null, 2)) }
}

/** Files outside the project folder are never written. */
export function writesOutside(toolName: string, input: Json, cwd: string): boolean {
  if (!EDIT_TOOLS.has(toolName)) return false
  const target = input.file_path ?? input.notebook_path
  if (typeof target !== 'string') return false
  const relative = path.relative(cwd, path.resolve(cwd, target))
  return relative.startsWith('..') || path.isAbsolute(relative)
}

/** Claude Code's AskUserQuestion input, as questions for a card. */
export function askedQuestions(input: Json): AgentQuestion[] {
  const raw = Array.isArray(input.questions) ? (input.questions as Json[]) : []
  return raw.map((q, index) => ({
    id: String(index),
    header: String(q.header ?? ''),
    question: String(q.question ?? ''),
    options: (Array.isArray(q.options) ? (q.options as Json[]) : []).map((o) => ({
      label: String(o.label ?? ''),
      description: typeof o.description === 'string' && o.description !== '' ? o.description : null,
    })),
    multiSelect: q.multiSelect === true,
    allowOther: true,
  }))
}

/** What Claude Code needs back: the answers keyed by question text, a multi-select joined by commas. */
export function answeredInput(input: Json, questions: AgentQuestion[], answers: QuestionAnswers): Json {
  const byQuestion: Record<string, string> = {}
  for (const q of questions) {
    const chosen = answers[q.id] ?? []
    if (chosen.length) byQuestion[q.question] = chosen.join(', ')
  }
  return { ...input, answers: byQuestion }
}

export type ToolDecision = true | string | { input: Json }

/**
 * Only what Claude Code itself would ask about reaches here: reads and commands it considers safe inside the
 * project (ls, git status, …) go ahead without asking, as they do in Claude Code.
 */
export async function approveClaudeTool(request: AgentRunRequest, tool: string, input: Json, connectors: ReadonlyMap<string, string> = new Map()): Promise<ToolDecision> {
  // A question is for the user even in auto, as in Claude Code.
  if (tool === 'AskUserQuestion') {
    const questions = askedQuestions(input)
    const answers = questions.length ? await request.askUser(questions) : null
    return answers ? { input: answeredInput(input, questions, answers) } : 'ユーザーは質問に答えませんでした。'
  }
  const connector = mcpTool(tool)
  if (request.access === 'write' && request.approval === 'auto') return true
  if (connector) {
    // A read-only turn: only connector tools checked to have no side effects go ahead; a name that sounds
    // like reading is not enough, and nothing else is asked about, since an approval would let it change things.
    if (request.access === 'read') return isVerifiedClaudeRead(tool, connectors) ? true : 'このターンは読み取り専用です。確認済みの読み取り以外の連携操作は使えません。'
    if (isReadOnlyTool(connector.tool)) return true
    const decision = await request.requestApproval({
      kind: 'other',
      title: `${connector.server} を操作: ${connector.tool}`,
      detail: clip(JSON.stringify(input, null, 2)),
    })
    return decision === 'allow' ? true : 'ユーザーが許可しませんでした。'
  }
  if (WEB_TOOLS.has(tool)) return true
  // A read-only turn changes nothing. A read Claude Code asks about (outside the project) is the user's call;
  // a command it asks about could write, and an approval would let it, so it is refused.
  if (request.access === 'read' && !READ_TOOLS.has(tool)) return 'このターンは読み取り専用です。'
  if (request.access === 'write' && writesOutside(tool, input, request.cwd)) return '作業フォルダの外には書き込めません。'
  const decision = await request.requestApproval(describePermission(tool, input, request.cwd))
  return decision === 'allow' ? true : 'ユーザーが許可しませんでした。'
}

/**
 * Every connector (MCP) call comes to approveClaudeTool, even one the user's Claude Code settings allow: an `ask`
 * rule goes before allow rules. Given on every turn, so a read-only turn keeps the same process and prompt cache.
 */
export const MCP_ASK_SETTINGS = { permissions: { ask: ['mcp__*'] } }

/** Reuses one live Claude Code process per session while its launch settings match. */
export class ClaudeAdapter implements AgentAdapter {
  readonly id = 'claude' as const
  private readonly children = new Set<ReturnType<typeof spawn>>()
  private readonly processes = new Set<ClaudeSession>()
  private readonly sessions = new Map<string, ClaudeSession>()
  /** The prompt cache a session's last process left, kept when the process closes. */
  private readonly caches = new Map<string, CacheState>()
  /** Sessions whose transcript has been read for it, once per app run. */
  private readonly restored = new Set<string>()
  /** Read once per app run, unless the CLI or its connector configuration changes. */
  private models: Promise<ClaudeModelInfo[]> | null = null

  constructor(private readonly options: ClaudeAdapterOptions) {}

  static buildArgs(request: Pick<AgentRunRequest, 'systemPrompt' | 'model' | 'effort' | 'sessionId' | 'access' | 'approval'>): string[] {
    // Claude Code as it usually is (its own instructions, tools and connectors), with the group chat explained
    // on top. Whatever needs permission comes to us over stdin/stdout (stream-json), to be shown as a card.
    // The mode stays manual even for auto, which approveClaudeTool allows. A read-only turn keeps the same tools,
    // as Claude Code's own modes do, so the process and its prompt cache stay; what Claude Code asks about is
    // refused there, while commands the user's settings already allow go ahead as in Claude Code.
    const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--append-system-prompt', request.systemPrompt]
    args.push('--input-format', 'stream-json', '--permission-mode', 'manual', '--permission-prompts', 'host', '--permission-prompt-tool', 'stdio')
    args.push('--settings', JSON.stringify(MCP_ASK_SETTINGS))
    if (request.model) args.push('--model', request.model)
    if (request.effort) args.push('--effort', request.effort)
    if (request.sessionId) args.push('--resume', request.sessionId)
    return args
  }

  async run(request: AgentRunRequest): Promise<AgentRunResult> {
    const stopped: AgentRunResult = { text: '', status: 'stopped' }
    const binary = await this.options.resolveBinary()
    if (request.signal.aborted) return stopped
    const { sessionId, cwd } = request
    const args = ClaudeAdapter.buildArgs({ ...request, sessionId: null })
    const key = JSON.stringify([binary, cwd, args])
    const existing = sessionId ? this.sessions.get(sessionId) : undefined
    if (existing) {
      await existing.waitForTurn(request)
      if (request.signal.aborted) return stopped
      if (existing.matches(key)) {
        await existing.compactOnReturn(request)
        if (request.signal.aborted) return stopped
        if (existing.matches(key)) return existing.run(request)
      }
      // Never open the same transcript in a second process while the old one is still closing.
      await existing.close()
      if (request.signal.aborted) return stopped
    }
    if (sessionId && !this.restored.has(sessionId)) {
      // After AgentSync restarts, only Claude Code's transcript knows how large the conversation was.
      this.restored.add(sessionId)
      const cache = this.caches.has(sessionId) ? null : await transcriptCache(this.options.env(), sessionId).catch(() => null)
      if (cache) this.caches.set(sessionId, cache)
      if (request.signal.aborted) return stopped
    }
    if (sessionId && this.sessions.has(sessionId)) throw new Error('このClaude Codeセッションは実行中です')
    const session = this.start(binary, args, key, request)
    await session.compactOnReturn(request)
    if (request.signal.aborted) return stopped
    if (session.matches(key)) return session.run(request)
    // The CLI could not compact (or was closed meanwhile); go on without compacting.
    await session.close()
    if (request.signal.aborted) return stopped
    return this.start(binary, args, key, request).run(request)
  }

  private start(binary: string, args: string[], key: string, request: AgentRunRequest): ClaudeSession {
    const { sessionId, cwd } = request
    const forget = (id: string | null) => {
      if (id && this.sessions.get(id) === session) this.sessions.delete(id)
    }
    const session = new ClaudeSession({
      binary,
      args: sessionId ? [...args, '--resume', sessionId] : args,
      cwd,
      env: this.options.env(),
      sessionId,
      key,
      cache: sessionId ? this.caches.get(sessionId) : null,
      onCache: (cache) => {
        const id = session.sessionId
        if (!id) return
        if (cache) this.caches.set(id, cache)
        else this.caches.delete(id)
      },
      approve: approveClaudeTool,
      onSession: (id, previous) => {
        forget(previous)
        this.sessions.set(id, session)
      },
      onClose: () => {
        forget(session.sessionId)
        this.processes.delete(session)
      },
    })
    if (sessionId) this.sessions.set(sessionId, session)
    this.processes.add(session)
    return session
  }

  /** CLI selection or connector changes take effect after the current replies. */
  reload(): void {
    this.models = null
    for (const session of this.processes) session.retire()
  }

  async choices(model: string | null): Promise<AgentChoices> {
    let models: ClaudeModelInfo[] = []
    try {
      models = await this.listModels()
    } catch {
      // An older Claude Code may not answer; a model ID can still be typed in.
    }
    // 「default」 is what Claude Code picks by itself, which is 「自動」 here.
    const current =
      model === null
        ? models.find((m) => m.value === 'default')
        : (models.find((m) => m.value === model) ?? models.find((m) => m.resolvedModel === model))
    const efforts = current ? (current.supportsEffort ? (current.supportedEffortLevels ?? []) : []) : [...CLAUDE_EFFORTS]
    return {
      models: models
        .filter((m) => m.value !== 'default')
        .map((m) => ({ value: m.value, label: m.displayName || m.value, description: m.description || null })),
      defaultModel: null,
      customModel: true,
      efforts,
      defaultEffort: null,
    }
  }

  private listModels(): Promise<ClaudeModelInfo[]> {
    this.models ??= this.readModels().catch((error: unknown) => {
      this.models = null
      throw error
    })
    return this.models
  }

  /** Starts Claude Code just to ask for its model list; no prompt is sent, so no usage is spent. */
  private async readModels(): Promise<ClaudeModelInfo[]> {
    const binary = await this.options.resolveBinary()
    return new Promise<ClaudeModelInfo[]>((resolve, reject) => {
      const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--tools', '', '--strict-mcp-config']
      const child = spawn(binary, args, {
        ...(this.options.listCwd ? { cwd: this.options.listCwd } : {}),
        env: this.options.env(),
        stdio: ['pipe', 'pipe', 'ignore'],
      })
      this.children.add(child)
      const finish = () => {
        clearTimeout(timer)
        this.children.delete(child)
        child.stdin.end()
        child.kill('SIGTERM')
      }
      const timer = setTimeout(() => {
        finish()
        reject(new Error('Claude Code からモデルの一覧を受け取れませんでした'))
      }, 20_000)
      readline.createInterface({ input: child.stdout }).on('line', (line) => {
        const models = parseModelList(line)
        if (models === null) return
        finish()
        resolve(models)
      })
      child.on('error', (error) => {
        finish()
        reject(error)
      })
      child.on('close', () => {
        finish()
        reject(new Error('Claude Code が終了しました'))
      })
      child.stdin.on('error', () => {
        // Reported through close.
      })
      child.stdin.write(`${JSON.stringify({ type: 'control_request', request_id: 'agentsync-models', request: { subtype: 'initialize' } })}\n`)
    })
  }

  dispose(): void {
    for (const session of this.processes) void session.close()
    for (const child of this.children) child.kill('SIGTERM')
    this.children.clear()
  }
}
