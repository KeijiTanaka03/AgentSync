import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { AGENT_IDS, type AgentId } from '../../shared/types'
import { isEffort } from '../../shared/validate'

/** App-wide choices that carry over to new conversations. */
export interface Settings {
  /** The last reasoning effort chosen for each agent (null: the CLI's own setting). */
  efforts: Record<AgentId, string | null>
}

const FORMAT_VERSION = 1

export function defaultSettings(): Settings {
  return { efforts: Object.fromEntries(AGENT_IDS.map((id) => [id, null])) as Record<AgentId, string | null> }
}

/** Reads a settings file, keeping whatever is valid. */
export function parseSettings(raw: unknown): Settings {
  const settings = defaultSettings()
  if (typeof raw !== 'object' || raw === null) return settings
  const { version, efforts } = raw as Record<string, unknown>
  if (version !== FORMAT_VERSION || typeof efforts !== 'object' || efforts === null) return settings
  for (const id of AGENT_IDS) {
    const effort = (efforts as Record<string, unknown>)[id]
    if (isEffort(effort)) settings.efforts[id] = effort
  }
  return settings
}

/** `settings.json` in the app's data folder: written atomically and readable only by the user. */
export class SettingsStore {
  constructor(readonly file: string) {}

  /** The saved settings; defaults when there is no file yet or it cannot be read. */
  load(): Settings {
    try {
      return parseSettings(JSON.parse(readFileSync(this.file, 'utf8')))
    } catch {
      return defaultSettings()
    }
  }

  save(settings: Settings): void {
    mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 })
    const temporary = `${this.file}.tmp`
    const data = { version: FORMAT_VERSION, efforts: settings.efforts }
    writeFileSync(temporary, JSON.stringify(data, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
    renameSync(temporary, this.file)
  }
}
