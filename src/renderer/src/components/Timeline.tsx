import { useLayoutEffect, useRef } from 'react'
import type { AgentId, AgentInfo, ChatMessage } from '../../../shared/types'
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

export function Timeline({ messages, agents }: { messages: ChatMessage[]; agents: Record<AgentId, AgentInfo> }) {
  const scroller = useRef<HTMLDivElement>(null)
  const stickToBottom = useRef(true)
  const lastCount = useRef(messages.length)

  useLayoutEffect(() => {
    const element = scroller.current
    if (!element) return
    const added = messages.slice(lastCount.current)
    lastCount.current = messages.length
    // Always follow your own new message; otherwise follow only if already at the bottom.
    if (stickToBottom.current || added.some((m) => m.from === 'user')) {
      element.scrollTop = element.scrollHeight
      stickToBottom.current = true
    }
  }, [messages])

  const onScroll = () => {
    const element = scroller.current
    if (!element) return
    stickToBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < STICK_THRESHOLD
  }

  return (
    <div className="timeline" ref={scroller} onScroll={onScroll}>
      {messages.length === 0 ? (
        <div className="empty">
          <h2>Claude と GPT に話しかけてみましょう</h2>
          <p>
            宛先を「全員」にすると、2 人に同時に届きます。
            <br />
            入力欄の先頭に <code>@Claude</code> や <code>@GPT</code> と書いても、宛先を切り替えられます。
          </p>
        </div>
      ) : (
        <section className="messages" aria-label="メッセージ" aria-live="polite">
          {withDialogueMarks(messages).map(({ message, inDialogue }) => (
            <MessageItem
              key={message.id}
              message={message}
              activity={message.from !== 'user' && message.from !== 'system' && message.status === 'streaming' ? agents[message.from].activity : null}
              interrupt={inDialogue && message.from === 'user'}
            />
          ))}
        </section>
      )}
    </div>
  )
}
