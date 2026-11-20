import { otherAgent, type AgentId, type ApprovalMode, type ChatMessage, type FileAttachment, type Recipient, type Sender } from '../../shared/types'

/** Names used inside prompts (the UI calls the user 「あなた」, the agents see 「ユーザー」). */
const PROMPT_NAMES: Record<Sender, string> = {
  user: 'ユーザー',
  claude: 'Claude',
  gpt: 'GPT',
  system: 'AgentSync',
}

/** The reviewer named by a `review-diff` notice (the agent that did not implement). */
function reviewerOf(message: ChatMessage): AgentId {
  return otherAgent(message.implementer ?? 'claude')
}

/** The reviewer's sign that the changes are fine: APPROVED on the first line (Markdown marks allowed). */
export function isApproved(reply: string): boolean {
  const first = reply.split('\n').find((line) => line.trim() !== '') ?? ''
  return /^[\s*_`#>]*APPROVED\b/.test(first)
}

/** What a notice in the timeline tells each agent. Prompts are in English: fewer tokens. */
function noticeForAgent(message: ChatMessage, self: AgentId): string {
  const other = PROMPT_NAMES[otherAgent(self)]
  switch (message.notice) {
    case 'dialogue-start':
      return `Dialogue mode: you and ${other} take turns until the user stops it.`
    case 'dialogue-stop':
      return 'Dialogue mode ended.'
    case 'review-start':
      return (message.implementer ?? 'claude') === self
        ? `Implement + review: implement the user's last request. ${other} reviews your git diff after each turn; fix what ${other} points out.`
        : `Implement + review: ${other} implements, you review the request and git diff sent after each turn, read-only. Point out problems specifically (file, place, fix).`
    case 'review-diff': {
      const diff = message.detail ?? ''
      return message.implementer === self || self !== reviewerOf(message)
        ? `Your git diff was sent to ${other} for review.`
        : [
            `${other} finished. Current git diff:`,
            diff ? `\n\n\`\`\`diff\n${diff}\n\`\`\`\n\n` : ' (none: not a git repository, or no changes)\n\n',
            'Review it read-only. If there are no problems, reply with APPROVED on the first line.',
          ].join('')
    }
    case 'review-stop':
      return 'Implement + review ended.'
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
    (m) => !delivered.has(m.id) && m.from !== self && m.status !== 'streaming' && (m.text.trim() !== '' || attachmentsFor(m, self).length > 0),
  )
}

export function attachmentsFor(message: ChatMessage, agent: AgentId): readonly FileAttachment[] {
  return message.from === 'user' && (message.to === 'all' || message.to === agent) ? message.attachments ?? [] : []
}

/** Formats unseen messages as one prompt, each with a 【sender → recipient】 heading. */
export function formatUnseen(unseen: readonly ChatMessage[], self: AgentId, filePath?: (file: FileAttachment) => string | null): string {
  return unseen
    .map((m) => {
      if (m.from === 'system') return `【AgentSync】\n${noticeForAgent(m, self)}`
      const files = attachmentsFor(m, self).map((file) => {
        const location = filePath?.(file)
        return location ? `- ${JSON.stringify(file.name)} ${JSON.stringify(location)}` : `- ${JSON.stringify(file.name)} (unavailable)`
      })
      const attached = files.length ? `\n\nAttached files:\n${files.join('\n')}` : ''
      return `【${PROMPT_NAMES[m.from]} → ${recipientLabel(m.to, self)}】\n${m.text.trim()}${attached}`
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

/** For a coding conversation: what the agent may do on this turn, said at the start of its prompt. */
export function turnNote(access: 'read' | 'write', approval: ApprovalMode): string {
  const note =
    access === 'read'
      ? 'This turn is read-only: read and search, change nothing.'
      : approval === 'auto'
        ? 'This turn you may change files and run commands, without approval (auto), outside the folder too.'
        : 'This turn you may change files in the folder and run commands; each needs user approval.'
  return `【AgentSync】\n${note}`
}

/**
 * The one rule a CLI's own instructions cannot know: the others' messages arrive too, for context, and only
 * those addressed to this agent are to be answered. Stays the same for the whole conversation (prompt cache).
 */
export const GROUP_CHAT_PROMPT =
  'This is a group chat. Messages arrive headed 【sender → recipient】. Reply only to those addressed to あなた or 全員, and do not head your reply.'
