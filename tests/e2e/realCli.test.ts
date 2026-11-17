// Talks to the real Claude Code CLI and Codex CLI. Uses a little of your plan's usage.
// Run with: npm run test:e2e
// Models default to small ones; override with AGENTSYNC_CLAUDE_MODEL / AGENTSYNC_GPT_MODEL.
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { SendTarget } from '../../src/shared/types'
import { ClaudeAdapter } from '../../src/main/agents/claude'
import { CodexAdapter } from '../../src/main/agents/codex'
import { StdioRpcConnection } from '../../src/main/agents/jsonRpc'
import { ChatManager } from '../../src/main/chat/manager'
import { childEnv, findExecutable, loadLoginShellPath } from '../../src/main/env'
import { ConversationStore } from '../../src/main/store/conversationStore'

const enabled = process.env.AGENTSYNC_E2E === '1'

async function binary(name: string): Promise<string> {
  const found = await findExecutable(name)
  if (!found) throw new Error(`${name} not found on PATH`)
  return found
}

/** A fresh app (new CLI processes) on top of the same data folder. */
function startApp(dataDirectory: string): ChatManager {
  const cwd = path.join(dataDirectory, 'chat-workdir')
  mkdirSync(cwd, { recursive: true })
  return new ChatManager({
    store: new ConversationStore(path.join(dataDirectory, 'conversations')),
    cwd,
    emitEvent: () => {},
    emitConversations: () => {},
    saveDelayMs: 0,
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
}

/** Sends a message and waits for every reply it triggers. Returns those replies. */
async function ask(app: ChatManager, id: string, to: SendTarget, text: string, timeoutMs = 150_000) {
  const before = app.snapshot(id).state.messages.length
  const expected = to === 'all' ? 2 : 1
  app.send(id, { text, to })
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const replies = app.snapshot(id).state.messages.slice(before + 1)
    if (replies.length >= expected && replies.every((m) => m.status !== 'streaming')) {
      for (const reply of replies) expect(reply.status, reply.error).toBe('done')
      return replies
    }
    if (Date.now() > deadline) throw new Error('timed out waiting for replies')
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
}

describe.skipIf(!enabled)('real CLIs', () => {
  it(
    'answers in parallel, shares what the other agent said, and continues after a restart',
    async () => {
      await loadLoginShellPath()
      const data = mkdtempSync(path.join(tmpdir(), 'agentsync-e2e-'))

      // --- First run ---
      let app = startApp(data)
      const id = app.create()
      try {
        // Both at once.
        const sums = await ask(app, id, 'all', '1 + 1 は？ 数字だけで答えてください。')
        expect(sums.map((m) => m.from).sort()).toEqual(['claude', 'gpt'])
        for (const reply of sums) expect(reply.text).toContain('2')

        // A secret for each agent. Neither repeats it, so later only its own session remembers it.
        await ask(app, id, 'claude', 'あなただけへの合言葉は「かぼす」です。覚えておいて、「了解」とだけ返してください。')
        await ask(app, id, 'gpt', 'あなただけへの合言葉は「すだち」です。覚えておいて、「了解」とだけ返してください。')
      } finally {
        app.dispose()
      }

      // --- Second run: new CLI processes, same files ---
      app = startApp(data)
      try {
        expect(app.list().map((c) => c.id)).toEqual([id])

        // Each agent must recall its own secret from its resumed CLI session.
        const [claude] = await ask(app, id, 'claude', 'ユーザーが、あなただけに伝えた合言葉を、そのまま書いてください。')
        expect(claude!.text).toContain('かぼす')
        const [gpt] = await ask(app, id, 'gpt', 'ユーザーが、あなただけに伝えた合言葉を、そのまま書いてください。')
        expect(gpt!.text).toContain('すだち')

        // And still receive what the other agent said.
        const [relay] = await ask(app, id, 'claude', 'GPT が直前に返した言葉を、そのまま書いてください。')
        expect(relay!.text).toContain('すだち')
      } finally {
        app.dispose()
      }
    },
    600_000,
  )

  it(
    'runs dialogue mode: the agents answer each other in turn until it is turned off',
    async () => {
      await loadLoginShellPath()
      const app = startApp(mkdtempSync(path.join(tmpdir(), 'agentsync-e2e-')))
      const id = app.create()
      try {
        await ask(app, id, 'all', 'ラーメンとうどん、どちらが好き？ Claude はラーメン派、GPT はうどん派として、1 文で答えてください。')
        const before = app.snapshot(id).state.messages.length
        app.setDialogue(id, true) // GPT spoke last, so Claude starts

        const deadline = Date.now() + 240_000
        const dialogueReplies = () =>
          app.snapshot(id).state.messages.slice(before).filter((m) => m.from === 'claude' || m.from === 'gpt')
        while (dialogueReplies().filter((m) => m.status !== 'streaming').length < 2) {
          if (Date.now() > deadline) throw new Error('timed out waiting for the dialogue')
          await new Promise((resolve) => setTimeout(resolve, 300))
        }
        app.setDialogue(id, false)

        const [first, second] = dialogueReplies()
        expect([first!.from, first!.to, first!.status]).toEqual(['claude', 'gpt', 'done'])
        expect([second!.from, second!.to, second!.status]).toEqual(['gpt', 'claude', 'done'])
        expect(first!.text.trim()).not.toBe('')
        expect(second!.text.trim()).not.toBe('')
        const notices = app.snapshot(id).state.messages.filter((m) => m.from === 'system').map((m) => m.notice)
        expect(notices).toEqual(['dialogue-start', 'dialogue-stop'])
        expect(app.snapshot(id).state.dialogue).toBeNull()
      } finally {
        app.dispose()
      }
    },
    300_000,
  )
})
