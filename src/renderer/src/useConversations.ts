import { useEffect, useState } from 'react'
import type { ConversationSummary } from '../../shared/types'

/** The conversation list, kept up to date by the main process. Null until it has loaded. */
export function useConversations(): ConversationSummary[] | null {
  const [conversations, setConversations] = useState<ConversationSummary[] | null>(null)

  useEffect(() => {
    let active = true
    let updatedByEvent = false
    // Every event carries the whole list, so the newest one always wins.
    const unsubscribe = window.agentsync.onConversations((list) => {
      updatedByEvent = true
      setConversations(list)
    })
    void window.agentsync.listConversations().then((list) => {
      if (active && !updatedByEvent) setConversations(list)
    })
    return () => {
      active = false
      unsubscribe()
    }
  }, [])

  return conversations
}
