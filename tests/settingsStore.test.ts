import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { SettingsStore } from '../src/main/store/settingsStore'

const fileIn = () => path.join(mkdtempSync(path.join(tmpdir(), 'agentsync-settings-')), 'settings.json')

describe('SettingsStore', () => {
  it('starts with the CLI settings when there is no file yet', () => {
    expect(new SettingsStore(fileIn()).load()).toEqual({ efforts: { claude: null, gpt: null } })
  })

  it('saves the chosen efforts, readable only by the user', () => {
    const file = fileIn()
    const store = new SettingsStore(file)
    store.save({ efforts: { claude: 'high', gpt: 'low' } })
    expect(new SettingsStore(file).load()).toEqual({ efforts: { claude: 'high', gpt: 'low' } })
    expect(JSON.parse(readFileSync(file, 'utf8')).version).toBe(1)
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  it('ignores a broken file and values that are not effort names', () => {
    const file = fileIn()
    writeFileSync(file, '{ not json')
    expect(new SettingsStore(file).load()).toEqual({ efforts: { claude: null, gpt: null } })
    writeFileSync(file, JSON.stringify({ version: 1, efforts: { claude: 'max', gpt: '--rm' } }))
    expect(new SettingsStore(file).load()).toEqual({ efforts: { claude: 'max', gpt: null } })
  })
})
