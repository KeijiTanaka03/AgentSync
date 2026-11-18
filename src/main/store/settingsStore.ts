import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { AGENT_IDS, type AgentId } from '../../shared/types'
import { isEffort, isModel } from '../../shared/validate'

/** The CLIs AgentSync runs. */
export type CliName = 'claude' | 'codex'

/** App-wide choices. */
export interface Settings {
  window?: { x: number; y: number; width: number; height: number; maximized: boolean }
  /** The last model chosen for each agent; new conversations start with it (null: the CLI's own setting). */
  models: Record<AgentId, string | null>
  /** The last reasoning effort chosen for each agent, likewise. */
  efforts: Record<AgentId, string | null>
  /** Executables chosen with 「CLI の場所…」 (null: look on PATH). */
  cliPaths: Record<CliName, string | null>
}

const FORMAT_VERSION = 1

const perAgent = (): Record<AgentId, string | null> =>
  Object.fromEntries(AGENT_IDS.map((id) => [id, null])) as Record<AgentId, string | null>

export function defaultSettings(): Settings {
  return { models: perAgent(), efforts: perAgent(), cliPaths: { claude: null, codex: null } }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

/** Reads a settings file, keeping whatever is valid. */
export function parseSettings(raw: unknown): Settings {
  const settings = defaultSettings()
  if (!isRecord(raw) || raw.version !== FORMAT_VERSION) return settings
  const { models, efforts, cliPaths } = raw
  for (const id of AGENT_IDS) {
    if (isRecord(models) && isModel(models[id])) settings.models[id] = models[id]
    if (isRecord(efforts) && isEffort(efforts[id])) settings.efforts[id] = efforts[id]
  }
  for (const name of ['claude', 'codex'] as const) {
    const value = isRecord(cliPaths) ? cliPaths[name] : null
    if (typeof value === 'string' && path.isAbsolute(value)) settings.cliPaths[name] = value
  }
  const window = raw.window
  if (isRecord(window)) {
    const { x, y, width, height, maximized } = window
    if (typeof x === 'number' && Number.isSafeInteger(x) && typeof y === 'number' && Number.isSafeInteger(y)
      && typeof width === 'number' && Number.isSafeInteger(width) && width > 0
      && typeof height === 'number' && Number.isSafeInteger(height) && height > 0
      && typeof maximized === 'boolean') {
      settings.window = { x, y, width, height, maximized }
    }
  }
  return settings
}

/** `settings.json` in the app's data folder: written atomically and readable only by the user. */
export class SettingsStore {
  private current: Settings

  constructor(readonly file: string) {
    this.current = this.read()
  }

  /** The saved settings; defaults when there is no file yet or it cannot be read. */
  load(): Settings {
    return structuredClone(this.current)
  }

  /** Changes some settings and writes the file. */
  update(change: (settings: Settings) => void): Settings {
    const next = this.load()
    change(next)
    this.save(next)
    return this.load()
  }

  save(settings: Settings): void {
    mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 })
    const temporary = `${this.file}.tmp`
    const data = { version: FORMAT_VERSION, ...settings }
    writeFileSync(temporary, JSON.stringify(data, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
    renameSync(temporary, this.file)
    this.current = structuredClone(settings)
  }

  private read(): Settings {
    try {
      return parseSettings(JSON.parse(readFileSync(this.file, 'utf8')))
    } catch {
      return defaultSettings()
    }
  }
}
