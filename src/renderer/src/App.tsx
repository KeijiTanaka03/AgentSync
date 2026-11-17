import { useCallback, useEffect, useRef, useState } from 'react'
import { ChatView } from './components/ChatView'
import { Sidebar } from './components/Sidebar'
import { errorMessage } from './errors'
import { useConversations } from './useConversations'

export function App() {
  const conversations = useConversations()
  const [activeId, setActiveId] = useState<string | null>(null)
  const started = useRef(false)

  const createConversation = useCallback(() => {
    void window.agentsync.createConversation().then(setActiveId, (error: unknown) => console.error(errorMessage(error)))
  }, [])

  // On start, open the most recent conversation (or a new one when there is none).
  useEffect(() => {
    if (!conversations || started.current) return
    started.current = true
    const latest = conversations[0]
    if (latest) setActiveId(latest.id)
    else createConversation()
  }, [conversations, createConversation])

  useEffect(
    () =>
      window.agentsync.onMenuCommand((command) => {
        if (command === 'new-conversation') createConversation()
      }),
    [createConversation],
  )

  const deleteConversation = (id: string) => {
    const remaining = (conversations ?? []).filter((c) => c.id !== id)
    void window.agentsync.deleteConversation(id).then(
      (deleted) => {
        if (!deleted || id !== activeId) return
        const next = remaining[0]
        if (next) setActiveId(next.id)
        else createConversation()
      },
      (error: unknown) => console.error(errorMessage(error)),
    )
  }

  const renameConversation = (id: string, title: string) => {
    void window.agentsync.renameConversation(id, title).catch((error: unknown) => console.error(errorMessage(error)))
  }

  if (!conversations) return <div className="loading">読み込み中…</div>

  return (
    <div className="app">
      <Sidebar
        conversations={conversations}
        activeId={activeId}
        onSelect={setActiveId}
        onCreate={createConversation}
        onRename={renameConversation}
        onDelete={deleteConversation}
      />
      {activeId ? <ChatView key={activeId} conversationId={activeId} /> : <main className="chat" />}
    </div>
  )
}
