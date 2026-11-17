import { useLayoutEffect, useRef, useState } from 'react'
import type { AgentId, AgentInfo, ApprovalDecision, ChatMessage, ConversationKind } from '../../../shared/types'
import { ArrowDownIcon } from './icons'
import { MessageItem } from './MessageItem'

/** Distance from the bottom (px) within which new content keeps the view pinned to the bottom. */
const STICK_THRESHOLD = 96

/** Pairs each message with whether it came during a dialogue (between its start and stop notices). */
function withDialogueMarks(messages: ChatMessage[]): { message: ChatMessage; inDialogue: boolean }[] {
  let inDialogue = false
  return messages.map((message) => {
    if (message.notice === 'dialogue-start') inDialogue = true
    else if (message.notice === 'dialogue-stop') inDialogue = false
    return { message, inDialogue }
  })
}

interface TimelineProps {
  initialScrollTop?: number
  followOwnMessages?: boolean
  messages: ChatMessage[]
  agents: Record<AgentId, AgentInfo>
  kind?: ConversationKind
  onApprove?(approvalId: string, decision: ApprovalDecision): void
}

export function Timeline({ messages, agents, kind = 'chat', onApprove, followOwnMessages = true, initialScrollTop }: TimelineProps) {
  const scroller = useRef<HTMLDivElement>(null)
  const stickToBottom = useRef(true)
  const initialized = useRef(false)
  const lastCount = useRef(messages.length)
  const [awayFromBottom, setAwayFromBottom] = useState(false)

  useLayoutEffect(() => {
    const element = scroller.current
    if (!element) return
    if (!initialized.current) {
      initialized.current = true
      if (initialScrollTop !== undefined) {
        element.scrollTop = initialScrollTop
        stickToBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < STICK_THRESHOLD
        setAwayFromBottom(!stickToBottom.current)
        return
      }
    }
    const added = messages.slice(lastCount.current)
    lastCount.current = messages.length
    // In split view each pane follows only while already at the bottom.
    if (stickToBottom.current || (followOwnMessages && added.some((m) => m.from === 'user'))) {
      element.scrollTop = element.scrollHeight
      stickToBottom.current = true
      setAwayFromBottom(false)
    }
  }, [messages, followOwnMessages, initialScrollTop])

  const onScroll = () => {
    const element = scroller.current
    if (!element) return
    stickToBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < STICK_THRESHOLD
    setAwayFromBottom(!stickToBottom.current)
  }

  const toBottom = () => {
    const element = scroller.current
    if (!element) return
    element.scrollTo({ top: element.scrollHeight, behavior: 'smooth' })
    stickToBottom.current = true
  }

  return (
    <div className="timeline-wrap">
      <div className="timeline" ref={scroller} onScroll={onScroll}>
        {messages.length === 0 ? (
          kind === 'code' ? (
            <div className="empty">
              <h2>このフォルダで作業を頼んでみましょう</h2>
              <p>
                宛先を Claude か GPT にすると、その 1 人がファイルを変更し、コマンドを実行できます（承認制なら、その前に確認します）。
                <br />
                「全員」宛てと対話モードでは、2 人とも読み取り専用で、コードを読みながら答えます。
              </p>
            </div>
          ) : (
            <div className="empty">
              <h2>Claude と GPT に話しかけてみましょう</h2>
              <p>
                宛先を「全員」にすると、2 人に同時に届きます。
                <br />
                入力欄の先頭に <code>@Claude</code> や <code>@GPT</code> と書いても、宛先を切り替えられます。
              </p>
            </div>
          )
        ) : (
          <section className="messages" aria-label="メッセージ" aria-live="polite">
            {withDialogueMarks(messages).map(({ message, inDialogue }) => (
              <MessageItem
                key={message.id}
                message={message}
                activity={message.from !== 'user' && message.from !== 'system' && message.status === 'streaming' ? agents[message.from].activity : null}
                interrupt={inDialogue && message.from === 'user'}
                {...(onApprove ? { onApprove } : {})}
              />
            ))}
          </section>
        )}
      </div>
      {awayFromBottom && (
        <button type="button" className="jump-to-latest" onClick={toBottom}>
          <ArrowDownIcon size={15} />
          最新へ
        </button>
      )}
    </div>
  )
}
