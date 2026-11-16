import { execFile } from 'node:child_process'
import { access, constants } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

/**
 * Variables that describe a running Claude Code session. They leak in when the app is
 * started from inside Claude Code (e.g. during development) and would make the child
 * `claude` process think it is nested in that session.
 */
const SESSION_SCOPED_VARIABLES = [
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
]

/** The environment for child CLI processes. */
export function childEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...base }
  for (const key of SESSION_SCOPED_VARIABLES) delete env[key]
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

/**
 * Apps started from Finder do not inherit the shell's PATH, so `claude` and `codex`
 * would not be found. Read PATH from the user's login shell and merge it in.
 */
export async function loadLoginShellPath(): Promise<void> {
  if (process.platform === 'win32') return
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

/** Finds an executable on PATH. `override` (an absolute path) wins when given. */
export async function findExecutable(name: string, override?: string): Promise<string | null> {
  const candidates = override
    ? [override]
    : (process.env.PATH ?? '').split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, name))
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK)
      return candidate
    } catch {
      // try the next one
    }
  }
  return null
}
