import { describe, expect, it } from 'vitest'
import { isVerifiedClaudeRead, isVerifiedCodexRead } from '../src/main/agents/connectorReads'

describe('verified connector reads', () => {
  const claudeAi = new Map([['claude_ai_Notion', 'claudeai'], ['claude_ai_Google_Drive', 'claudeai']])

  it('trusts the listed reads of a connector the running Claude Code says comes from claude.ai', () => {
    expect(isVerifiedClaudeRead('mcp__claude_ai_Notion__notion-search', claudeAi)).toBe(true)
    expect(isVerifiedClaudeRead('mcp__claude_ai_Google_Drive__read_file_content', claudeAi)).toBe(true)
    expect(isVerifiedClaudeRead('mcp__claude_ai_Notion__notion-create-pages', claudeAi)).toBe(false)
  })

  it('trusts nothing whose provider is another or unknown', () => {
    expect(isVerifiedClaudeRead('mcp__claude_ai_Notion__notion-search', new Map([['claude_ai_Notion', 'user']]))).toBe(false)
    expect(isVerifiedClaudeRead('mcp__claude_ai_Notion__notion-search', new Map())).toBe(false)
  })

  it('trusts a Codex connector only when the thread’s connection goes to the official origin', () => {
    expect(isVerifiedCodexRead('https://mcp.notion.com', 'notion-search')).toBe(true)
    expect(isVerifiedCodexRead('https://evil.example', 'notion-search')).toBe(false)
    expect(isVerifiedCodexRead(null, 'notion-search')).toBe(false)
    expect(isVerifiedCodexRead('https://mcp.notion.com', 'notion-create-pages')).toBe(false)
  })
})
