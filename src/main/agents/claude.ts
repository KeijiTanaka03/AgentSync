import { spawn } from 'node:child_process'
import readline from 'node:readline'
import type { AgentAdapter, AgentRunRequest, AgentRunResult } from './types'
import { ClaudeStreamParser } from './claudeStream'

export interface ClaudeAdapterOptions {
  /** Resolves the `claude` executable. */
  resolveBinary(): Promise<string>
  /** Environment for the child process. */
  env(): NodeJS.ProcessEnv
}

const STDERR_LIMIT = 8_000

/**
 * Runs one `claude -p` process per turn and continues the conversation with `--resume`.
 * In chat mode all tools and MCP servers are off, so Claude can only talk.
 */
export class ClaudeAdapter implements AgentAdapter {
  readonly id = 'claude' as const
  private readonly children = new Set<ReturnType<typeof spawn>>()

  constructor(private readonly options: ClaudeAdapterOptions) {}

  static buildArgs(request: Pick<AgentRunRequest, 'systemPrompt' | 'model' | 'sessionId'>): string[] {
    const args = [
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--tools',
      '',
      '--strict-mcp-config',
      '--system-prompt',
      request.systemPrompt,
    ]
    if (request.model) args.push('--model', request.model)
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

      const parser = new ClaudeStreamParser()
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
          else if (event.kind === 'text') request.onText(event.text)
          else outcome = event.ok ? { ok: true, text: event.text } : { ok: false, error: event.error }
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
      child.stdin.end(request.prompt)
    })
  }

  dispose(): void {
    for (const child of this.children) child.kill('SIGTERM')
    this.children.clear()
  }
}
