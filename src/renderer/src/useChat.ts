import { useCallback, useEffect, useState } from 'react'
import { applyEvent } from '../../shared/state'
import type { ChatEventEnvelope, ChatState, SendRequest } from '../../shared/types'

/** Mirrors the main process's chat state: a snapshot first, then events. */
export function useChat() {
  const [state, setState] = useState<ChatState | null>(null)

  useEffect(() => {
    let snapshotSeq: number | null = null
    const buffered: ChatEventEnvelope[] = []
    let active = true

    // Subscribe before asking for the snapshot so no event falls in between.
    const unsubscribe = window.agentsync.onEvent((envelope) => {
      if (snapshotSeq === null) {
        buffered.push(envelope)
        return
      }
      if (envelope.seq <= snapshotSeq) return
      setState((current) => (current ? applyEvent(current, envelope.event) : current))
    })

    void window.agentsync.snapshot().then((snapshot) => {
      if (!active) return
      let next = snapshot.state
      for (const envelope of buffered) {
        if (envelope.seq > snapshot.seq) next = applyEvent(next, envelope.event)
      }
      buffered.length = 0
      snapshotSeq = snapshot.seq
      setState(next)
    })

    return () => {
      active = false
      unsubscribe()
    }
  }, [])

  const send = useCallback((request: SendRequest) => window.agentsync.send(request), [])
  const stop = useCallback(() => window.agentsync.stop(), [])

  return { state, send, stop }
}
