import { DISPLAY_NAMES, type ChatMessage, type Recipient } from '../../../shared/types'
import { Avatar } from './Avatar'
import { MarkdownText } from './MarkdownText'

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

export function MessageItem({ message }: { message: ChatMessage }) {
  const time = formatTime(message.at)

  if (message.from === 'user') {
    return (
      <div className="row row-user">
        <div className="bubble bubble-user">
          <span className={`to-tag to-tag-${message.to}`}>{USER_TAGS[message.to]}</span>
          <span className="user-text">{message.text}</span>
        </div>
        <span className="time">{time}</span>
      </div>
    )
  }

  const agent = message.from
  const streaming = message.status === 'streaming'
  return (
    <div className="row row-agent">
      <Avatar agent={agent} />
      <div className="agent-body">
        <div className="meta">
          <b>{DISPLAY_NAMES[agent]}</b> · {replyLabel(message.to)} · {time}
        </div>
        <div className={`bubble bubble-agent bubble-${agent}`} aria-busy={streaming}>
          {streaming && message.text === '' ? (
            <span className="typing">
              <span className="dot" />
              <span className="dot" />
              <span className="dot" />
              <span className="typing-label">{DISPLAY_NAMES[agent]} が入力中…</span>
            </span>
          ) : (
            message.text !== '' && <MarkdownText text={message.text} />
          )}
          {streaming && message.text !== '' && <span className="caret" aria-hidden="true" />}
          {message.status === 'stopped' && <p className="note">停止しました</p>}
          {message.status === 'error' && (
            <p className="error" role="alert">
              {message.error ?? 'エラーが発生しました'}
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
