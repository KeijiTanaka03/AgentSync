import { DISPLAY_NAMES, type AgentActivity, type ApprovalDecision, type ChatMessage, type Recipient } from '../../../shared/types'
import { ActivityLine } from './Activity'
import { Avatar } from './Avatar'
import { CopyButton } from './CopyButton'
import { MarkdownText } from './MarkdownText'
import { UrlText } from './UrlText'
import { ApprovalCard, DiffText, WorkLog } from './WorkLog'

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })
}

const USER_TAGS: Record<Recipient, string> = {
  all: '全員へ',
  claude: 'Claudeへ',
  gpt: 'GPTへ',
  user: '',
}

function replyLabel(to: Recipient): string {
  if (to === 'user') return 'あなたへ'
  if (to === 'all') return '全員へ'
  return `▸ ${DISPLAY_NAMES[to]} への返信`
}

interface MessageItemProps {
  message: ChatMessage
  /** What the sender is doing, for a reply that is still streaming. */
  activity: AgentActivity | null
  /** You said this during a dialogue: it goes to the next speaker. */
  interrupt?: boolean
  /** Answers an approval card in this reply. */
  onApprove?(approvalId: string, decision: ApprovalDecision): void
}

export function MessageItem({ message, activity, interrupt = false, onApprove }: MessageItemProps) {
  const time = formatTime(message.at)

  // A notice from AgentSync, shown as a line across the timeline (「ここから対話モード」).
  if (message.from === 'system') {
    const line = <p className={`notice notice-${message.notice ?? 'info'}`}>{message.text}</p>
    if (!message.detail) return line
    // 実装＋レビュー: the diff handed to the reviewer, folded.
    return (
      <div className="notice-block">
        {line}
        <details className="notice-detail">
          <summary>差分を見る</summary>
          <DiffText text={message.detail} className="notice-diff" />
        </details>
      </div>
    )
  }

  if (message.from === 'user') {
    return (
      <div className="row row-user">
        {interrupt && <span className="interrupt-label">割り込み · 次の話者に渡されます</span>}
        <div className="bubble bubble-user">
          <span className={`to-tag to-tag-${message.to}`}>{USER_TAGS[message.to]}</span>
          <span className="user-text"><UrlText text={message.text} /></span>
        </div>
        <span className="time">{time}</span>
      </div>
    )
  }

  const agent = message.from
  const streaming = message.status === 'streaming'
  // While writing, the caret is enough; otherwise say what the agent is doing (also between paragraphs).
  const doing: AgentActivity | null = streaming ? (activity ?? { kind: 'thinking' }) : null
  const writing = doing?.kind === 'writing' && message.text !== ''
  return (
    <div className="row row-agent">
      <Avatar agent={agent} />
      <div className="agent-body">
        <div className="meta">
          <b>{DISPLAY_NAMES[agent]}</b> · {replyLabel(message.to)} · {time}
        </div>
        <div className={`bubble bubble-agent bubble-${agent}`} aria-busy={streaming}>
          {message.tools && message.tools.length > 0 && <WorkLog tools={message.tools} live={streaming} />}
          {message.text !== '' && <MarkdownText text={message.text} />}
          {writing && <span className="caret" aria-hidden="true" />}
          {doing && !writing && <ActivityLine activity={doing} since={message.at} />}
          {message.approvals?.map((approval) => (
            <ApprovalCard key={approval.id} approval={approval} onAnswer={(decision) => onApprove?.(approval.id, decision)} />
          ))}
          {message.status === 'stopped' && <p className="note">停止しました</p>}
          {message.status === 'error' && (
            <p className="error" role="alert">
              {message.error ?? 'エラーが発生しました'}
            </p>
          )}
        </div>
        {!streaming && message.text !== '' && (
          <div className="message-actions">
            <CopyButton getText={() => message.text} />
          </div>
        )}
      </div>
    </div>
  )
}
