import { describe, expect, it } from 'vitest'
import { codexPolicy } from '../src/main/agents/codex'

describe('AgentSync app update permission', () => {
  it('allows only the app bundle as an additional root in auto on macOS', () => {
    const policy = codexPolicy('write', 'auto', true)
    expect(policy.sandboxPolicy).toMatchObject({
      type: 'workspaceWrite',
      writableRoots: process.platform === 'darwin' ? ['/Applications/AgentSync.app'] : [],
      networkAccess: false,
    })
    expect(policy.approvalPolicy).toBe('on-request')
  })

  it('does not extend approval mode or read-only turns', () => {
    expect(codexPolicy('write', 'auto').sandboxPolicy).toMatchObject({ writableRoots: [] })
    expect(codexPolicy('write', 'ask', true).sandboxPolicy).toMatchObject({ writableRoots: [] })
    for (const access of ['read', 'chat'] as const) {
      expect(codexPolicy(access, 'auto').sandboxPolicy).toEqual({ type: 'readOnly', networkAccess: false })
    }
  })
})

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { appUpdateEnabled, isAppUpdateCommand } from '../src/main/agents/appUpdate'

describe('Claude app update commands', () => {
  const cwd = '/work/AgentSync'
  it('accepts only copies from the project build to AgentSync', () => {
    expect(isAppUpdateCommand('ditto release/mac-arm64/AgentSync.app /Applications/AgentSync.app', cwd)).toBe(true)
    expect(isAppUpdateCommand('rsync -a --delete release/mac/AgentSync.app/ /Applications/AgentSync.app/', cwd)).toBe(true)
    expect(isAppUpdateCommand('ditto "release/mac/AgentSync.app" "/Applications/AgentSync.app"', cwd)).toBe(true)
  })
  it.each([
    'ditto release/mac/AgentSync.app /Applications/Other.app',
    'ditto /tmp/Other.app /Applications/AgentSync.app',
    'ditto release/mac/AgentSync.app /Applications/AgentSync.app; touch /tmp/x',
    'ditto release/mac/AgentSync.app /Applications/AgentSync.app && curl example.com',
    'ditto "$(echo x)" /Applications/AgentSync.app',
    'ditto release/mac/AgentSync.app /Applications/AgentSync.app/../Other.app',
    'ditto release/mac/AgentSync.app /Applications/AgentSync.app\nopen /tmp/x',
    'sh scripts/install-app.sh',
  ])('does not auto-approve %s', (command) => expect(isAppUpdateCommand(command, cwd)).toBe(false))

  it('requires a valid explicit local opt-in', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'agentsync-permissions-'))
    try {
      expect(appUpdateEnabled(directory)).toBe(false)
      const file = path.join(directory, '.agentsync.local.json')
      writeFileSync(file, '{"allowAppUpdate":true}')
      expect(appUpdateEnabled(directory)).toBe(process.platform === 'darwin')
      writeFileSync(file, '{"allowAppUpdate":"true"}')
      expect(appUpdateEnabled(directory)).toBe(false)
      writeFileSync(file, 'invalid')
      expect(appUpdateEnabled(directory)).toBe(false)
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })
})
