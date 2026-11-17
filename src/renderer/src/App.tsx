import { useCallback, useEffect, useRef, useState } from 'react'
import { ChatView } from './components/ChatView'
import { ConnectionsPanel } from './components/ConnectionsPanel'
import { Sidebar } from './components/Sidebar'
import { UsagePanel } from './components/UsagePanel'
import type { ConversationKind } from '../../shared/types'
import { errorMessage } from './errors'
import { useConversations } from './useConversations'

export function App() {
  const conversations = useConversations()
  const [activeId, setActiveId] = useState<string | null>(null)
  const [panel, setPanel] = useState<'connections' | 'usage' | null>(null)
  // Which list the sidebar shows: chats or coding conversations. Follows the open conversation.
  const [mode, setMode] = useState<ConversationKind>('chat')
  const activeKind = conversations?.find((c) => c.id === activeId)?.kind
  useEffect(() => {
    if (activeKind) setMode(activeKind)
  }, [activeId, activeKind])
  const started = useRef(false)

  const createConversation = useCallback(() => {
    void window.agentsync.createConversation().then(setActiveId, (error: unknown) => console.error(errorMessage(error)))
  }, [])

  const createCodeConversation = useCallback(() => {
    void window.agentsync.createCodeConversation().then(
      (id) => {
        if (id) setActiveId(id)
      },
      (error: unknown) => console.error(errorMessage(error)),
    )
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
        else if (command === 'new-code-conversation') createCodeConversation()
        else if (command === 'connections' || command === 'usage') setPanel(command)
      }),
    [createConversation, createCodeConversation],
  )

  // Switching opens the latest conversation of that kind (a new chat when there is none).
  const switchMode = (next: ConversationKind) => {
    if (next === mode) return
    setMode(next)
    const latest = (conversations ?? []).find((c) => c.kind === next)
    if (latest) setActiveId(latest.id)
    else if (next === 'chat') createConversation()
    else setActiveId(null)
  }

  const deleteConversation = (id: string) => {
    const remaining = (conversations ?? []).filter((c) => c.id !== id && c.kind === mode)
    void window.agentsync.deleteConversation(id).then(
      (deleted) => {
        if (!deleted || id !== activeId) return
        const next = remaining[0]
        if (next) setActiveId(next.id)
        else if (mode === 'chat') createConversation()
        else setActiveId(null)
      },
      (error: unknown) => console.error(errorMessage(error)),
    )
  }

  const pinConversation = (id: string, pinned: boolean) => {
    void window.agentsync.pinConversation(id, pinned).catch((error: unknown) => console.error(errorMessage(error)))
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
        mode={mode}
        onMode={switchMode}
        onSelect={setActiveId}
        onCreate={createConversation}
        onCreateCode={createCodeConversation}
        onRename={renameConversation}
        onPin={pinConversation}
        onDelete={deleteConversation}
        onConnections={() => setPanel('connections')}
        onUsage={() => setPanel('usage')}
      />
      {activeId ? (
        <ChatView key={activeId} conversationId={activeId} />
      ) : (
        <main className="chat chat-blank">
          <div className="empty">
            <h2>プロジェクトのフォルダで作業を始めましょう</h2>
            <p>
              <button type="button" className="new-conversation" onClick={createCodeConversation}>
                新しいコーディング会話…
              </button>
            </p>
          </div>
        </main>
      )}
      {panel === 'connections' && <ConnectionsPanel onClose={() => setPanel(null)} />}
      {panel === 'usage' && <UsagePanel onClose={() => setPanel(null)} />}
    </div>
  )
}
