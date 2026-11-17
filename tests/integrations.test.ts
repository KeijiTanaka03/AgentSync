import { describe, expect, it } from 'vitest'
import { codexUsageWindows, parseClaudeConnections, parseClaudeUsage, parseCodexConnections } from '../src/main/integrations'

describe('parseClaudeUsage', () => {
  it('reads the limit lines of /usage and skips the advice under them', () => {
    const text = `You are currently using your subscription to power your Claude Code usage

Current session: 85% used · resets Nov 17 at 6:59pm (Asia/Tokyo)
Current week (all models): 80% used · resets Nov 18 at 1:59pm (Asia/Tokyo)
Current week (Fable): 0% used · resets Nov 18 at 2pm (Asia/Tokyo)

Last 24h · 626 requests · 35 sessions
  99%  Stop sessions you no longer need · some ran 8 hours or more
`
    expect(parseClaudeUsage(text)).toEqual([
      { label: '5 時間枠', usedPercent: 85, resets: 'Nov 17 at 6:59pm (Asia/Tokyo)' },
      { label: '今週（全モデル）', usedPercent: 80, resets: 'Nov 18 at 1:59pm (Asia/Tokyo)' },
      { label: '今週（Fable）', usedPercent: 0, resets: 'Nov 18 at 2pm (Asia/Tokyo)' },
    ])
  })

  it('finds nothing in unrelated text', () => {
    expect(parseClaudeUsage('Unknown command')).toEqual([])
  })
})

describe('codexUsageWindows', () => {
  const window = (usedPercent: number, windowDurationMins: number) => ({ usedPercent, windowDurationMins, resetsAt: null })

  it('names the 5-hour and weekly windows', () => {
    expect(codexUsageWindows({ rateLimits: { primary: window(12, 300), secondary: window(40, 10_080) } })).toEqual([
      { label: '5 時間枠', usedPercent: 12, resets: null },
      { label: '1 週間', usedPercent: 40, resets: null },
    ])
  })

  it('prefixes the limit name when there are several', () => {
    const labels = codexUsageWindows({
      rateLimitsByLimitId: {
        a: { limitName: 'codex', primary: window(1, 300), secondary: null },
        b: { limitName: 'spark', primary: window(2, 300), secondary: null },
      },
    }).map((w) => w.label)
    expect(labels).toEqual(['codex · 5 時間枠', 'spark · 5 時間枠'])
  })
})

describe('connections', () => {
  it('reads claude mcp list, marking the claude.ai connectors', () => {
    const text = `Checking MCP server health…

claude.ai Notion: https://mcp.notion.com/mcp - ✔ Connected
linear: https://mcp.linear.app/mcp (HTTP) - ! Needs authentication
local: node server.js - ✗ Failed to connect`
    expect(parseClaudeConnections(text)).toEqual([
      { name: 'claude.ai Notion', target: 'https://mcp.notion.com/mcp', status: 'connected', managedAtClaudeAi: true },
      { name: 'linear', target: 'https://mcp.linear.app/mcp (HTTP)', status: 'needs-auth', managedAtClaudeAi: false },
      { name: 'local', target: 'node server.js', status: 'failed', managedAtClaudeAi: false },
    ])
  })

  it('reads codex mcp list --json', () => {
    const json = JSON.stringify([
      { name: 'notion', enabled: true, transport: { type: 'streamable_http', url: 'https://mcp.notion.com/mcp' }, auth_status: 'o_auth' },
      { name: 'files', enabled: false, transport: { type: 'stdio', command: 'npx', args: ['server'] }, auth_status: 'unsupported' },
      { name: 'linear', enabled: true, transport: { url: 'https://mcp.linear.app/mcp' }, auth_status: 'not_logged_in' },
    ])
    expect(parseCodexConnections(json).map((c) => [c.name, c.target, c.status])).toEqual([
      ['notion', 'https://mcp.notion.com/mcp', 'connected'],
      ['files', 'npx server', 'disabled'],
      ['linear', 'https://mcp.linear.app/mcp', 'needs-auth'],
    ])
  })
})
