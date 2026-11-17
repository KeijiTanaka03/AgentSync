import { otherAgent, type AgentId, type ChatMessage, type Recipient, type Sender } from '../../shared/types'

/** Names used inside prompts (the UI calls the user 「あなた」, the agents see 「ユーザー」). */
const PROMPT_NAMES: Record<Sender, string> = {
  user: 'ユーザー',
  claude: 'Claude',
  gpt: 'GPT',
  system: 'AgentSync',
}

/** What a notice in the timeline tells each agent. */
function noticeForAgent(message: ChatMessage, self: AgentId): string {
  const other = PROMPT_NAMES[otherAgent(self)]
  switch (message.notice) {
    case 'dialogue-start':
      return [
        `ここから「対話モード」です。あなたと ${other} が交互に発言し、ユーザーが止めるまで続きます。`,
        `${other} の発言に応じて、賛成・反論・補足・質問などで話を前に進めてください。同じことの繰り返しは避けてください。`,
        'ユーザーの発言が途中で届いたら、それも踏まえてください。',
      ].join('')
    case 'dialogue-stop':
      return '対話モードが終わりました。ここからは普段のチャットに戻ります。'
    default:
      return message.text
  }
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
      if (m.from === 'system') return `【AgentSync からのお知らせ】\n${noticeForAgent(m, self)}`
      const note = m.status === 'stopped' ? '\n（この発言は途中で止められました）' : ''
      return `【${PROMPT_NAMES[m.from]} → ${recipientLabel(m.to, self)}】\n${m.text.trim()}${note}`
    })
    .join('\n\n')
}

/** Who the agent is answering: the sender of the last message addressed to it (or to everyone). */
export function replyTarget(unseen: readonly ChatMessage[], self: AgentId): Recipient {
  for (let i = unseen.length - 1; i >= 0; i--) {
    const m = unseen[i]!
    if (m.from !== 'system' && (m.to === self || m.to === 'all')) return m.from
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
    '- 「【AgentSync からのお知らせ】」は、このチャットのアプリからの案内です。従ってください。',
    '- あなたの返答は、そのままあなたの吹き出しとしてチャットに表示されます。見出しや自分の名前を先頭に付けないでください。',
    '- ユーザーと同じ言語で、チャットらしく簡潔に答えてください。Markdown を使えます。',
  ].join('\n')
}
