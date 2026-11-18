import { describe, expect, it } from 'vitest'
import { ClaudeAdapter } from '../src/main/agents/claude'
import { codexPolicy, connectorOverrides } from '../src/main/agents/codex'
import { codeSystemPrompt } from '../src/main/chat/prompt'
import { parseApprovalMode } from '../src/shared/validate'
import { parseConversation } from '../src/main/store/conversationStore'

const base = { systemPrompt: 'SYS', model: null, effort: null, sessionId: null, approval: 'auto' as const }
describe('persistent always-allow mode', () => {
  it('uses full permissions in both CLIs for write turns', () => {
    expect(codeSystemPrompt('claude', '/work/app', true)).toContain('作業フォルダ外も含めて追加確認なし')
    expect(ClaudeAdapter.buildArgs({ ...base, access: 'write' }).join(' ')).toContain('--permission-mode bypassPermissions')
    expect(codexPolicy('write', 'auto')).toEqual({ sandbox: 'danger-full-access', approvalPolicy: 'never', approvalsReviewer: 'user', sandboxPolicy: { type: 'dangerFullAccess' } })
    expect(connectorOverrides(['notion'], true)).toEqual({ 'mcp_servers.notion.default_tools_approval_mode': 'approve' })
    expect(connectorOverrides(['notion'])).toEqual({ 'mcp_servers.notion.default_tools_approval_mode': 'prompt' })
  })
  it('keeps reviewers and group conversations read-only', () => {
    for (const access of ['read', 'chat'] as const) {
      expect(ClaudeAdapter.buildArgs({ ...base, access }).join(' ')).toContain('--permission-mode manual')
      expect(codexPolicy(access, 'auto').sandbox).toBe('read-only')
    }
  })
  it('accepts and reloads the choice, while unknown values remain ask', () => {
    expect(parseApprovalMode('auto')).toBe('auto')
    expect(parseConversation({ version: 1, approvalMode: 'always', kind: 'code', workdir: '/work/app' }, 'a').approvalMode).toBe('auto')
    expect(parseConversation({ version: 1, approvalMode: 'unknown' }, 'a').approvalMode).toBe('ask')
  })
})
