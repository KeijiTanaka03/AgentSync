import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { defaultSettings, SettingsStore } from '../src/main/store/settingsStore'

const fileIn = () => path.join(mkdtempSync(path.join(tmpdir(), 'agentsync-settings-')), 'settings.json')

describe('SettingsStore', () => {
  it('starts with the CLI settings when there is no file yet', () => {
    expect(new SettingsStore(fileIn()).load()).toEqual({
      models: { claude: null, gpt: null },
      efforts: { claude: null, gpt: null },
      cliPaths: { claude: null, codex: null },
    })
  })

  it('saves changes, readable only by the user', () => {
    const file = fileIn()
    const store = new SettingsStore(file)
    store.update((next) => {
      next.models.claude = 'sonnet'
      next.efforts.gpt = 'low'
      next.cliPaths.codex = '/opt/homebrew/bin/codex'
    })
    expect(new SettingsStore(file).load()).toEqual({
      models: { claude: 'sonnet', gpt: null },
      efforts: { claude: null, gpt: 'low' },
      cliPaths: { claude: null, codex: '/opt/homebrew/bin/codex' },
    })
    expect(JSON.parse(readFileSync(file, 'utf8')).version).toBe(1)
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  it('hands out copies, so a change elsewhere is not saved by accident', () => {
    const store = new SettingsStore(fileIn())
    store.load().models.claude = 'opus'
    expect(store.load().models.claude).toBeNull()
  })

  it('ignores a broken file and values that are not valid', () => {
    const file = fileIn()
    writeFileSync(file, '{ not json')
    expect(new SettingsStore(file).load()).toEqual(defaultSettings())
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        models: { claude: '--rm', gpt: 'gpt-6-luna' },
        efforts: { claude: 'max', gpt: '--rm' },
        cliPaths: { claude: 'relative/claude', codex: '/usr/local/bin/codex' },
      }),
    )
    expect(new SettingsStore(file).load()).toEqual({
      models: { claude: null, gpt: 'gpt-6-luna' },
      efforts: { claude: 'max', gpt: null },
      cliPaths: { claude: null, codex: '/usr/local/bin/codex' },
    })
  })
})
