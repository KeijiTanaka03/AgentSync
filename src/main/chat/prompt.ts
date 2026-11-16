import type { AgentId, ChatMessage, Recipient, Sender } from '../../shared/types'

/** Names used inside prompts (the UI calls the user 「あなた」, the agents see 「ユーザー」). */
const PROMPT_NAMES: Record<Sender, string> = {
  user: 'ユーザー',
  claude: 'Claude',
  gpt: 'GPT',
}

function recipientLabel(to: Recipient, self: AgentId): string {
  if (to === 'all') return '全員'
  if (to === self) return 'あなた'
  return PROMPT_NAMES[to]
}

/**
 * Messages the agent has not received yet.
 * The agent's own messages are already in its CLI session, so they are skipped.
 * Messages still streaming are skipped too; they are delivered on a later turn.
 */
export function collectUnseen(messages: readonly ChatMessage[], self: AgentId, delivered: ReadonlySet<number>): ChatMessage[] {
  return messages.filter(
    (m) => !delivered.has(m.id) && m.from !== self && m.status !== 'streaming' && m.text.trim() !== '',
  )
}

/** Formats unseen messages as one prompt, each with a 【sender → recipient】 heading. */
export function formatUnseen(unseen: readonly ChatMessage[], self: AgentId): string {
  return unseen
    .map((m) => {
      const note = m.status === 'stopped' ? '\n（この発言は途中で止められました）' : ''
      return `【${PROMPT_NAMES[m.from]} → ${recipientLabel(m.to, self)}】\n${m.text.trim()}${note}`
    })
    .join('\n\n')
}

/** Who the agent is answering: the sender of the last message addressed to it (or to everyone). */
export function replyTarget(unseen: readonly ChatMessage[], self: AgentId): Sender {
  for (let i = unseen.length - 1; i >= 0; i--) {
    const m = unseen[i]!
    if (m.to === self || m.to === 'all') return m.from
  }
  return 'user'
}

export function chatSystemPrompt(self: AgentId): string {
  const other = self === 'claude' ? 'GPT' : 'Claude'
  return [
    `あなたは「${PROMPT_NAMES[self]}」として、グループチャットに参加しています。参加者は、ユーザー（人間）、Claude、GPT の 3 人です。`,
    '',
    '- 新しい発言は「【発言者 → 宛先】」という見出し付きで届きます。あなたが前回発言したあとに増えた分が、まとめて届きます。',
    '- 宛先が「あなた」か「全員」の発言に返答してください。それ以外の発言は、会話の流れとして読んでおいてください。',
    `- ${other} は、同じチャットにいる別の AI です。${other} の発言には、賛成・反対・補足など、自分の考えで応じて構いません。`,
    '- あなたの返答は、そのままあなたの吹き出しとしてチャットに表示されます。見出しや自分の名前を先頭に付けないでください。',
    '- ユーザーと同じ言語で、チャットらしく簡潔に答えてください。Markdown を使えます。',
  ].join('\n')
}
