import { useCallback, useEffect, useState } from 'react'
import { applyEvent } from '../../shared/state'
import type { AttachmentUpload, ChatEventEnvelope, ChatState, SendRequest } from '../../shared/types'

/** Mirrors one conversation's state in the main process: a snapshot first, then events. */
export function useChat(conversationId: string) {
  const [state, setState] = useState<ChatState | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  useEffect(() => {
    let snapshotSeq: number | null = null
    const buffered: ChatEventEnvelope[] = []
    let active = true
    setState(null)
    setLoadError(null)

    // Subscribe before asking for the snapshot so no event falls in between.
    const unsubscribe = window.agentsync.onEvent((envelope) => {
      if (envelope.conversationId !== conversationId) return
      if (snapshotSeq === null) {
        buffered.push(envelope)
        return
      }
      if (envelope.seq <= snapshotSeq) return
      setState((current) => (current ? applyEvent(current, envelope.event) : current))
    })

    window.agentsync.snapshot(conversationId).then(
      (snapshot) => {
        if (!active) return
        let next = snapshot.state
        for (const envelope of buffered) {
          if (envelope.seq > snapshot.seq) next = applyEvent(next, envelope.event)
        }
        buffered.length = 0
        snapshotSeq = snapshot.seq
        setState(next)
      },
      (error: unknown) => {
        if (active) setLoadError(error instanceof Error ? error.message : String(error))
      },
    )

    return () => {
      active = false
      unsubscribe()
    }
  }, [conversationId])

  const send = useCallback((request: SendRequest, files?: AttachmentUpload[]) => window.agentsync.send(conversationId, request, files), [conversationId])
  const stop = useCallback(() => window.agentsync.stop(conversationId), [conversationId])

  return { state, loadError, send, stop }
}
