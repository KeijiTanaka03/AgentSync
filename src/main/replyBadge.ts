import type { ConversationEventEnvelope } from '../shared/types'

/** Replies completed while the app is in the background, until it is focused again. */
export class ReplyBadge {
  private readonly replies = new Set<string>()

  constructor(private readonly display: (label: string) => void) {}

  receive(envelope: ConversationEventEnvelope, focused: boolean): boolean {
    const event = envelope.event
    if (focused || event.type !== 'message:update' || event.message.status !== 'done') return false
    if (event.message.from !== 'claude' && event.message.from !== 'gpt') return false
    const key = `${envelope.conversationId}:${event.message.id}`
    if (this.replies.has(key)) return false
    this.replies.add(key)
    this.display(String(this.replies.size))
    return true
  }

  clear(): void {
    this.replies.clear()
    this.display('')
  }
}
