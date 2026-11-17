import { appUpdateEnabled, APP_UPDATE_TARGET, isAppUpdateCommand } from './appUpdate'
import { spawn } from 'node:child_process'
import readline from 'node:readline'
import path from 'node:path'
import type { AgentChoices } from '../../shared/types'
import type { AgentAdapter, AgentRunRequest, AgentRunResult, ApprovalRequest } from './types'
import { ClaudeStreamParser, describeClaudeTool, isReadOnlyTool, mcpTool } from './claudeStream'

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

const STDERR_LIMIT = 8_000

/** The levels `claude --effort` accepts (Claude Code 2.1). Claude Code does not report which one it uses by default. */
export const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']

/** Tools for `read` access: reading and searching the project, and the web. */
const READ_TOOLS = 'Read,Glob,Grep,WebSearch,WebFetch'
/** Built-in tools that only read the web; they go ahead without asking. */
const WEB_TOOLS = new Set(['WebSearch', 'WebFetch'])
const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])
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

/**
 * Runs one `claude -p` process per turn and continues the conversation with `--resume`.
 * In chat mode all tools and MCP servers are off, so Claude can only talk.
 */
export class ClaudeAdapter implements AgentAdapter {
  readonly id = 'claude' as const
  private readonly children = new Set<ReturnType<typeof spawn>>()
  /** Read once per app run; Claude Code lists the same models until it is updated. */
  private models: Promise<ClaudeModelInfo[]> | null = null

  constructor(private readonly options: ClaudeAdapterOptions) {}

  static buildArgs(request: Pick<AgentRunRequest, 'systemPrompt' | 'model' | 'effort' | 'sessionId' | 'access' | 'approval'> & { cwd?: string }): string[] {
    // Claude Code as it usually is (its own instructions, tools and connectors), with the group chat explained
    // on top. Whatever needs permission comes to us over stdin/stdout (stream-json), to be shown as a card.
    const mode = request.access === 'write' && request.approval === 'auto' ? 'auto' : 'manual'
    const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--append-system-prompt', request.systemPrompt]
    // A read-only turn of a coding conversation: reading the project and the web, and the connectors.
    if (request.access === 'read') args.push('--tools', READ_TOOLS)
    args.push('--input-format', 'stream-json', '--permission-mode', mode, '--permission-prompts', 'host', '--permission-prompt-tool', 'stdio')
    if (mode === 'auto' && appUpdateEnabled(request.cwd)) args.push('--add-dir', APP_UPDATE_TARGET)
    if (request.model) args.push('--model', request.model)
    if (request.effort) args.push('--effort', request.effort)
    if (request.sessionId) args.push('--resume', request.sessionId)
    return args
  }

  async run(request: AgentRunRequest): Promise<AgentRunResult> {
    const binary = await this.options.resolveBinary()
    if (request.signal.aborted) return { text: '', status: 'stopped' }

    return new Promise<AgentRunResult>((resolve, reject) => {
      const child = spawn(binary, ClaudeAdapter.buildArgs(request), {
        cwd: request.cwd,
        env: this.options.env(),
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      this.children.add(child)

      const parser = new ClaudeStreamParser(request.access === 'chat' ? null : request.cwd)
      const send = (message: unknown) => {
        if (!child.stdin.writableEnded) child.stdin.write(`${JSON.stringify(message)}\n`)
      }
      const answer = async (requestId: string, body: Json) => {
        let response: Json
        if (body.subtype === 'can_use_tool' && typeof body.tool_name === 'string') {
          const input = (typeof body.input === 'object' && body.input !== null ? body.input : {}) as Json
          const connector = mcpTool(body.tool_name)
          if (connector) {
            // A connector: reading goes ahead, anything else is the user's call.
            const allowed =
              isReadOnlyTool(connector.tool) ||
              (await request.requestApproval({
                kind: 'other',
                title: `${connector.server} を操作: ${connector.tool}`,
                detail: clip(JSON.stringify(input, null, 2)),
              })) === 'allow'
            response = allowed ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: 'ユーザーが許可しませんでした。' }
          } else if (WEB_TOOLS.has(body.tool_name)) {
            response = { behavior: 'allow', updatedInput: input }
          } else if (request.access === 'read') {
            response = { behavior: 'deny', message: 'このターンは読み取り専用です。' }
          } else if (request.access === 'write' && request.approval === 'auto' && appUpdateEnabled(request.cwd) && body.tool_name === 'Bash' && isAppUpdateCommand(input.command, request.cwd)) {
            response = { behavior: 'allow', updatedInput: input }
          } else if (request.access === 'write' && writesOutside(body.tool_name, input, request.cwd)) {
            response = { behavior: 'deny', message: '作業フォルダの外には書き込めません。' }
          } else {
            const decision = await request.requestApproval(describePermission(body.tool_name, input, request.cwd))
            response = decision === 'allow' ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: 'ユーザーが許可しませんでした。' }
          }
          send({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } })
        } else {
          send({ type: 'control_response', response: { subtype: 'error', request_id: requestId, error: 'AgentSync はこの要求に対応していません' } })
        }
      }
      let outcome: { ok: true; text: string } | { ok: false; error: string } | null = null
      let stderr = ''
      let spawnError: Error | null = null

      const onAbort = () => child.kill('SIGTERM')
      request.signal.addEventListener('abort', onAbort, { once: true })

      child.on('error', (error) => {
        spawnError = error
      })
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk: string) => {
        stderr = (stderr + chunk).slice(-STDERR_LIMIT)
      })
      readline.createInterface({ input: child.stdout }).on('line', (line) => {
        for (const event of parser.push(line)) {
          if (event.kind === 'session') request.onSession(event.sessionId)
          else if (event.kind === 'model') request.onModel(event.model)
          else if (event.kind === 'activity') request.onActivity(event.activity)
          else if (event.kind === 'text') request.onText(event.text)
          else if (event.kind === 'tool') request.onTool(event.tool)
          else if (event.kind === 'control') void answer(event.requestId, event.request)
          else {
            outcome = event.ok ? { ok: true, text: event.text } : { ok: false, error: event.error }
            // With stream-json input the process waits for more; the turn is over.
            child.stdin.end()
          }
        }
      })

      child.on('close', (code) => {
        this.children.delete(child)
        request.signal.removeEventListener('abort', onAbort)
        const result = outcome as { ok: true; text: string } | { ok: false; error: string } | null
        if (request.signal.aborted && !result) {
          resolve({ text: parser.text, status: 'stopped' })
        } else if (result?.ok) {
          resolve({ text: result.text, status: 'done' })
        } else if (result) {
          reject(new Error(result.error))
        } else if (spawnError) {
          reject(new Error(`Claude Code CLI を起動できませんでした: ${spawnError.message}`))
        } else {
          const detail = stderr.trim() || `終了コード ${String(code)}`
          reject(new Error(`Claude Code CLI が応答せずに終了しました: ${detail}`))
        }
      })

      // The prompt goes through stdin, so it can be long and never looks like a flag.
      child.stdin.on('error', () => {
        // The process may exit before reading stdin; the close handler reports why.
      })
      send({ type: 'user', message: { role: 'user', content: request.prompt } })
    })
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
    for (const child of this.children) child.kill('SIGTERM')
    this.children.clear()
  }
}
