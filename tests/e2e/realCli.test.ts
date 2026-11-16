// Talks to the real Claude Code CLI and Codex CLI. Uses a little of your plan's usage.
// Run with: npm run test:e2e
// Models default to small ones; override with AGENTSYNC_CLAUDE_MODEL / AGENTSYNC_GPT_MODEL.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ClaudeAdapter } from '../../src/main/agents/claude'
import { CodexAdapter } from '../../src/main/agents/codex'
import { StdioRpcConnection } from '../../src/main/agents/jsonRpc'
import { Orchestrator } from '../../src/main/chat/orchestrator'
import { childEnv, findExecutable, loadLoginShellPath } from '../../src/main/env'

const enabled = process.env.AGENTSYNC_E2E === '1'

async function binary(name: string): Promise<string> {
  const found = await findExecutable(name)
  if (!found) throw new Error(`${name} not found on PATH`)
  return found
}

async function waitUntilSettled(orchestrator: Orchestrator, replies: number, timeoutMs = 150_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const agentMessages = orchestrator.snapshot().state.messages.filter((m) => m.from !== 'user')
    if (agentMessages.length >= replies && agentMessages.every((m) => m.status !== 'streaming')) return
    if (Date.now() > deadline) throw new Error('timed out waiting for replies')
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
}

describe.skipIf(!enabled)('real CLIs', () => {
  it(
    'answers in parallel and shares what the other agent said',
    async () => {
      await loadLoginShellPath()
      const cwd = mkdtempSync(path.join(tmpdir(), 'agentsync-e2e-'))
      const orchestrator = new Orchestrator({
        cwd,
        emit: () => {},
        models: {
          claude: process.env.AGENTSYNC_CLAUDE_MODEL ?? 'haiku',
          gpt: process.env.AGENTSYNC_GPT_MODEL ?? 'gpt-6-luna',
        },
        adapters: {
          claude: new ClaudeAdapter({ resolveBinary: () => binary('claude'), env: () => childEnv() }),
          gpt: new CodexAdapter({
            clientVersion: '0.0.0-test',
            connect: async () => new StdioRpcConnection(await binary('codex'), ['app-server'], { cwd, env: childEnv() }),
          }),
        },
      })

      try {
        // 1. Both at once.
        orchestrator.send({ text: '1 + 1 は？ 数字だけで答えてください。', to: 'all' })
        await waitUntilSettled(orchestrator, 2)
        let messages = orchestrator.snapshot().state.messages
        for (const reply of messages.filter((m) => m.from !== 'user')) {
          expect(reply.status, reply.error).toBe('done')
          expect(reply.text).toContain('2')
        }

        // 2. Only GPT, with a word Claude cannot guess.
        orchestrator.send({ text: '「すだち」という言葉だけを返してください。', to: 'gpt' })
        await waitUntilSettled(orchestrator, 3)

        // 3. Claude must have received GPT's reply as context (and resumed its own session).
        orchestrator.send({ text: 'GPT が直前に返した言葉を、そのまま書いてください。', to: 'claude' })
        await waitUntilSettled(orchestrator, 4)
        messages = orchestrator.snapshot().state.messages
        const last = messages.at(-1)!
        expect(last.from).toBe('claude')
        expect(last.status, last.error).toBe('done')
        expect(last.text).toContain('すだち')
      } finally {
        orchestrator.dispose()
      }
    },
    400_000,
  )
})
