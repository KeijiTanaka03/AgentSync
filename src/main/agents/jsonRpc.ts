import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import readline from 'node:readline'

export type RequestId = string | number

/** An error to send back for a request the server made to us. */
export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message)
  }
}

/** A JSON-RPC style connection: requests, notifications, and requests coming from the server. */
export interface RpcConnection {
  request<T = unknown>(method: string, params?: unknown): Promise<T>
  notify(method: string, params?: unknown): void
  /** Server → client notifications. */
  onNotification: (method: string, params: unknown) => void
  /** Server → client requests. Throw `RpcError` to answer with an error. */
  onServerRequest: (method: string, params: unknown) => Promise<unknown> | unknown
  /** Called once when the connection ends. */
  onClose: (error: Error) => void
  dispose(): void
}

interface Pending {
  method: string
  resolve(value: unknown): void
  reject(error: Error): void
}

const STDERR_LIMIT = 8_000

/**
 * Talks to a child process over stdio, one JSON message per line
 * (the format `codex app-server` uses; there is no `jsonrpc` field).
 */
export class StdioRpcConnection implements RpcConnection {
  onNotification: RpcConnection['onNotification'] = () => {}
  onServerRequest: RpcConnection['onServerRequest'] = (method) => {
    throw new RpcError(-32601, `未対応のリクエストです: ${method}`)
  }
  onClose: RpcConnection['onClose'] = () => {}

  private readonly child: ChildProcessWithoutNullStreams
  private readonly pending = new Map<RequestId, Pending>()
  private nextId = 1
  private closed = false
  private stderr = ''

  constructor(command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) {
    this.child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ['pipe', 'pipe', 'pipe'] })
    this.child.stdin.on('error', () => {
      // Reported through the close handler.
    })
    this.child.stderr.setEncoding('utf8')
    this.child.stderr.on('data', (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-STDERR_LIMIT)
    })
    readline.createInterface({ input: this.child.stdout }).on('line', (line) => this.onLine(line))
    this.child.on('error', (error) => this.close(error))
    this.child.on('close', (code) => {
      const detail = this.stderr.trim()
      this.close(new Error(`プロセスが終了しました（終了コード ${String(code)}）${detail ? `: ${detail}` : ''}`))
    })
  }

  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (this.closed) return Promise.reject(new Error('接続は終了しています'))
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { method, resolve: resolve as (value: unknown) => void, reject })
      this.write({ id, method, params })
    })
  }

  notify(method: string, params?: unknown): void {
    this.write(params === undefined ? { method } : { method, params })
  }

  dispose(): void {
    this.close(new Error('接続を閉じました'))
    this.child.kill('SIGTERM')
  }

  private write(message: unknown): void {
    if (this.closed) return
    this.child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  private onLine(line: string): void {
    let message: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(line)
      if (typeof parsed !== 'object' || parsed === null) return
      message = parsed as Record<string, unknown>
    } catch {
      return
    }
    const { id, method } = message
    const hasId = typeof id === 'string' || typeof id === 'number'

    if (typeof method === 'string' && hasId) {
      void this.answerServerRequest(id, method, message.params)
    } else if (typeof method === 'string') {
      this.onNotification(method, message.params)
    } else if (hasId) {
      const pending = this.pending.get(id)
      if (!pending) return
      this.pending.delete(id)
      if (message.error !== undefined) {
        const error = message.error as { message?: unknown }
        const text = typeof error?.message === 'string' ? error.message : JSON.stringify(message.error)
        pending.reject(new Error(`${pending.method}: ${text}`))
      } else {
        pending.resolve(message.result)
      }
    }
  }

  private async answerServerRequest(id: RequestId, method: string, params: unknown): Promise<void> {
    try {
      const result = await this.onServerRequest(method, params)
      this.write({ id, result: result ?? null })
    } catch (error) {
      const code = error instanceof RpcError ? error.code : -32603
      const message = error instanceof Error ? error.message : String(error)
      this.write({ id, error: { code, message } })
    }
  }

  private close(error: Error): void {
    if (this.closed) return
    this.closed = true
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
    this.onClose(error)
  }
}
