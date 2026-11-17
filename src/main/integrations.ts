// The plans' usage limits and the connectors (MCP servers) set up in each CLI, read and changed through
// the CLIs' own commands. Nothing here sends a prompt, so none of it uses the plans' usage.
import { execFile, spawn } from 'node:child_process'
import type { Connection, UsageReport, UsageWindow } from '../shared/types'

const TIMEOUT = 60_000

function run(binary: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; input?: string }): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(binary, args, { cwd: options.cwd, env: options.env, timeout: TIMEOUT, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error((stderr || error.message).trim().slice(0, 500)))
      else resolve(stdout)
    })
    child.stdin?.end(options.input ?? '')
  })
}

/** 「Current session: 77% used · resets Nov 17 at 6:59pm (Asia/Tokyo)」 and the like, from Claude Code's /usage. */
export function parseClaudeUsage(text: string): UsageWindow[] {
  const windows: UsageWindow[] = []
  for (const line of text.split('\n')) {
    const match = /^\s*(.+?):\s*(\d+(?:\.\d+)?)% used(?:\s*·\s*resets\s+(.+?))?\s*$/.exec(line)
    if (!match) continue
    const name = match[1]!
    const scoped = /^Current week \((.+)\)$/.exec(name)
    const label =
      name === 'Current session' ? '5 時間枠' : name === 'Current week (all models)' ? '今週（全モデル）' : scoped ? `今週（${scoped[1]}）` : name
    windows.push({ label, usedPercent: Number(match[2]), resets: match[3] ?? null })
  }
  return windows
}

export async function claudeUsage(binary: string, env: NodeJS.ProcessEnv, cwd: string): Promise<UsageReport> {
  try {
    // /usage is answered by Claude Code itself; no model is asked.
    const text = await run(binary, ['-p', '--output-format', 'text', '--strict-mcp-config', '--tools', ''], { cwd, env, input: '/usage' })
    const windows = parseClaudeUsage(text)
    return windows.length > 0 ? { windows, error: null } : { windows, error: '使用量を読み取れませんでした（Claude Code の表示が変わった可能性があります）' }
  } catch (error) {
    return { windows: [], error: error instanceof Error ? error.message : String(error) }
  }
}

interface RateLimitWindow {
  usedPercent: number
  windowDurationMins: number | null
  resetsAt: number | null
}

interface RateLimitSnapshot {
  limitName?: string | null
  primary: RateLimitWindow | null
  secondary: RateLimitWindow | null
}

function windowLabel(minutes: number | null): string {
  if (minutes === 300) return '5 時間枠'
  if (minutes === 10_080) return '1 週間'
  if (!minutes) return '枠'
  return minutes % 1_440 === 0 ? `${minutes / 1_440} 日` : `${Math.round(minutes / 60)} 時間枠`
}

function resetText(epochSeconds: number | null): string | null {
  if (!epochSeconds) return null
  return new Date(epochSeconds * 1000).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

/** The answer to Codex's `account/rateLimits/read`, as windows. */
export function codexUsageWindows(response: { rateLimits?: RateLimitSnapshot; rateLimitsByLimitId?: Record<string, RateLimitSnapshot | undefined> }): UsageWindow[] {
  const buckets = Object.values(response.rateLimitsByLimitId ?? {}).filter((b): b is RateLimitSnapshot => !!b)
  const snapshots = buckets.length > 0 ? buckets : response.rateLimits ? [response.rateLimits] : []
  return snapshots.flatMap((snapshot) =>
    [snapshot.primary, snapshot.secondary]
      .filter((w): w is RateLimitWindow => !!w)
      .map((w) => ({
        label: `${snapshots.length > 1 && snapshot.limitName ? `${snapshot.limitName} · ` : ''}${windowLabel(w.windowDurationMins)}`,
        usedPercent: w.usedPercent,
        resets: resetText(w.resetsAt),
      })),
  )
}

/** `claude mcp list`: 「claude.ai Notion: https://mcp.notion.com/mcp - ✔ Connected」 per line. */
export function parseClaudeConnections(text: string): Connection[] {
  const connections: Connection[] = []
  for (const line of text.split('\n')) {
    const colon = line.indexOf(': ')
    const dash = line.lastIndexOf(' - ')
    if (colon <= 0 || dash <= colon) continue
    const name = line.slice(0, colon).trim()
    const state = line.slice(dash + 3)
    const status: Connection['status'] = /connected/i.test(state) && !/fail|not/i.test(state)
      ? 'connected'
      : /auth/i.test(state)
        ? 'needs-auth'
        : /fail|✗|error/i.test(state)
          ? 'failed'
          : /disabled/i.test(state)
            ? 'disabled'
            : 'unknown'
    connections.push({ name, target: line.slice(colon + 2, dash).trim(), status, managedAtClaudeAi: name.startsWith('claude.ai ') })
  }
  return connections
}

/** `codex mcp list --json`. */
export function parseCodexConnections(json: string): Connection[] {
  const list = JSON.parse(json) as { name: string; enabled: boolean; transport?: { url?: string; command?: string; args?: string[] }; auth_status?: string }[]
  return list.map((server) => ({
    name: server.name,
    target: server.transport?.url ?? [server.transport?.command, ...(server.transport?.args ?? [])].filter(Boolean).join(' '),
    status: !server.enabled ? 'disabled' : server.auth_status === 'not_logged_in' ? 'needs-auth' : 'connected',
    managedAtClaudeAi: false,
  }))
}

export const listClaudeConnections = async (binary: string, env: NodeJS.ProcessEnv, cwd: string) =>
  parseClaudeConnections(await run(binary, ['mcp', 'list'], { cwd, env }))

export const listCodexConnections = async (binary: string, env: NodeJS.ProcessEnv, cwd: string) =>
  parseCodexConnections(await run(binary, ['mcp', 'list', '--json'], { cwd, env }))

export async function addConnection(cli: 'claude' | 'codex', binary: string, env: NodeJS.ProcessEnv, cwd: string, name: string, url: string): Promise<void> {
  // For every project (user scope), as connectors usually are.
  const args = cli === 'claude' ? ['mcp', 'add', '--transport', 'http', '--scope', 'user', name, url] : ['mcp', 'add', name, '--url', url]
  await run(binary, args, { cwd, env })
}

export async function removeConnection(binary: string, env: NodeJS.ProcessEnv, cwd: string, name: string): Promise<void> {
  await run(binary, ['mcp', 'remove', name], { cwd, env })
}

/** Codex signs in to a connector in the browser and waits for it; this does not wait. */
export function startCodexLogin(binary: string, env: NodeJS.ProcessEnv, cwd: string, name: string, onDone: (ok: boolean) => void): void {
  const child = spawn(binary, ['mcp', 'login', name], { cwd, env, stdio: 'ignore' })
  const timer = setTimeout(() => child.kill('SIGTERM'), 10 * 60_000)
  child.on('close', (code) => {
    clearTimeout(timer)
    onDone(code === 0)
  })
  child.on('error', () => {
    clearTimeout(timer)
    onDone(false)
  })
}
