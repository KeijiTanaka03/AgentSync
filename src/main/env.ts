import { execFile } from 'node:child_process'
import { access, constants, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

/**
 * Variables that describe a running Claude Code session. They leak in when the app is
 * started from inside Claude Code (e.g. during development) and would make the child
 * `claude` process think it is nested in that session.
 */
const SESSION_SCOPED_VARIABLES = new Set([
  'CLAUDECODE',
  'CLAUDE_PID',
  'CLAUDE_EFFORT',
  'CLAUDE_AGENT_SDK_VERSION',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_SSE_PORT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_EMIT_STARTUP_TIMING',
  'CLAUDE_CODE_STARTUP_FAILURE_RESULTS',
  'CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING',
  'CLAUDE_CODE_QUESTION_PREVIEW_FORMAT',
  'CLAUDE_CODE_ENABLE_TASKS',
  'ELECTRON_RUN_AS_NODE',
])

/** The environment for child CLI processes. */
export function childEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...base }
  for (const key of Object.keys(env)) {
    if (SESSION_SCOPED_VARIABLES.has(process.platform === 'win32' ? key.toUpperCase() : key)) delete env[key]
  }
  return env
}

function mergePathLists(...lists: (string | undefined)[]): string {
  const seen = new Set<string>()
  for (const list of lists) {
    for (const entry of (list ?? '').split(path.delimiter)) {
      if (entry) seen.add(entry)
    }
  }
  return [...seen].join(path.delimiter)
}

/** Include installs that a desktop launcher may have missed in its inherited PATH. */
export async function loadExecutablePath(): Promise<void> {
  if (process.platform === 'win32') {
    process.env.PATH = mergePathLists(process.env.PATH, windowsInstallDirectories(process.env, homedir()).join(path.delimiter))
    return
  }
  // Apps started from Finder do not inherit the login shell's PATH.
  const shell = process.env.SHELL && path.isAbsolute(process.env.SHELL) ? process.env.SHELL : '/bin/zsh'
  const marker = '__AGENTSYNC_PATH__'
  const shellPath = await new Promise<string | undefined>((resolve) => {
    execFile(
      shell,
      ['-ilc', `printf '%s%s%s' '${marker}' "$PATH" '${marker}'`],
      { timeout: 5_000, env: { ...process.env, DISABLE_AUTO_UPDATE: 'true' } },
      (error, stdout) => {
        if (error) return resolve(undefined)
        const match = new RegExp(`${marker}(.*)${marker}`).exec(stdout)
        resolve(match?.[1])
      },
    )
  })
  const home = homedir()
  const commonDirectories = ['/opt/homebrew/bin', '/usr/local/bin', path.join(home, '.local', 'bin')].join(path.delimiter)
  process.env.PATH = mergePathLists(shellPath, process.env.PATH, commonDirectories)
}

function windowsInstallDirectories(env: NodeJS.ProcessEnv, home: string): string[] {
  const { join } = path.win32
  const local = env.LOCALAPPDATA ?? join(home, 'AppData', 'Local')
  const roaming = env.APPDATA ?? join(home, 'AppData', 'Roaming')
  const programFiles = env.ProgramW6432 ?? env.ProgramFiles ?? 'C:\\Program Files'
  return [
    join(home, '.local', 'bin'),
    join(roaming, 'npm'),
    join(local, 'Microsoft', 'WinGet', 'Links'),
    join(programFiles, 'WinGet', 'Links'),
    join(programFiles, 'Git', 'cmd'),
    join(local, 'Programs', 'Git', 'cmd'),
  ]
}

/** Resolve npm launchers to their native executable so arguments travel directly to the CLI. */
export function windowsExecutableCandidates(name: string, override: string | undefined, env: NodeJS.ProcessEnv, home: string, arch: string): string[] {
  const { basename, dirname, extname, isAbsolute, join } = path.win32
  function npmExecutables(dir: string): string[] {
    const nodeModules = basename(dir).toLowerCase() === '.bin' ? dirname(dir) : join(dir, 'node_modules')
    if (name === 'claude') return [join(nodeModules, '@anthropic-ai', 'claude-code', 'bin', 'claude.exe')]
    if (name !== 'codex') return []
    const scope = join(nodeModules, '@openai')
    const codex = join(scope, 'codex')
    return [...new Set([arch, 'x64', 'arm64'])].filter((cpu) => cpu === 'arm64' || cpu === 'x64').flatMap((cpu) => {
      const vendor = join('vendor', cpu === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc', 'bin', 'codex.exe')
      const platformPackage = join('@openai', `codex-win32-${cpu}`)
      return [join(nodeModules, platformPackage, vendor), join(codex, 'node_modules', platformPackage, vendor), join(codex, vendor)]
    })
  }
  if (override) {
    if (!isAbsolute(override)) return []
    if (extname(override).toLowerCase() === '.exe') return [override]
    return basename(override).toLowerCase() === `${name}.cmd` ? npmExecutables(dirname(override)) : []
  }
  const fromPath = (env.PATH ?? env.Path ?? '').split(';').map((dir) => dir.trim().replace(/^"(.*)"$/, '$1'))
  return [...new Set([...fromPath, ...windowsInstallDirectories(env, home)].filter(isAbsolute))]
    .flatMap((dir) => [join(dir, `${name}.exe`), ...npmExecutables(dir)])
}

/** Finds an executable on PATH. `override` (an absolute path) wins when given. */
export async function findExecutable(name: string, override?: string): Promise<string | null> {
  const candidates = process.platform === 'win32'
    ? windowsExecutableCandidates(name, override, process.env, homedir(), process.arch)
    : override ? [override] : (process.env.PATH ?? '').split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, name))
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK)
      if ((await stat(candidate)).isFile()) return candidate
    } catch {
      // try the next one
    }
  }
  return null
}
