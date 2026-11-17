import { readFileSync } from 'node:fs'
import path from 'node:path'

export const APP_UPDATE_TARGET = '/Applications/AgentSync.app'

/** Local opt-in, deliberately excluded from the public repository. */
export function appUpdateEnabled(cwd?: string): boolean {
  if (process.platform !== 'darwin' || !cwd) return false
  try {
    return JSON.parse(readFileSync(path.join(cwd, '.agentsync.local.json'), 'utf8')).allowAppUpdate === true
  } catch {
    return false
  }
}

/** Only complete copy commands to this app bundle; shell composition must still ask. */
export function isAppUpdateCommand(command: unknown, cwd: string): boolean {
  if (typeof command !== 'string' || /[\n\r$`;&|<>\\()]/.test(command)) return false
  const tokens: string[] = []
  const pattern = /\s*(?:"([^"]*)"|'([^']*)'|([^\s"']+))/gy
  let position = 0
  while (position < command.trimEnd().length) {
    pattern.lastIndex = position
    const match = pattern.exec(command)
    if (!match) return false
    tokens.push(match[1] ?? match[2] ?? match[3]!)
    position = pattern.lastIndex
  }
  const [binary, ...args] = tokens
  if (!binary) return false
  const ditto = binary === 'ditto' || binary === '/usr/bin/ditto'
  const rsync = binary === 'rsync' || binary === '/usr/bin/rsync'
  const operands = ditto && args.length === 2 ? args
    : rsync && args.length === 4 && args[0] === '-a' && args[1] === '--delete' ? args.slice(2) : null
  if (!operands) return false
  const [source, destination] = operands as [string, string]
  return ['release/mac-arm64/AgentSync.app', 'release/mac/AgentSync.app'].some((relative) => path.resolve(cwd, source) === path.resolve(cwd, relative))
    && path.resolve(cwd, destination) === APP_UPDATE_TARGET
}
