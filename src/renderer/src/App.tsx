import { useCallback, useEffect, useRef, useState } from 'react'
import { ChatView } from './components/ChatView'
import { ConnectionsPanel } from './components/ConnectionsPanel'
import { Sidebar } from './components/Sidebar'
import { UsagePanel } from './components/UsagePanel'
import { keepPane, selectConversation, splitPane, type ConversationPane } from './panes'
import { SplitIcon } from './components/icons'
import type { ConversationKind, SendTarget } from '../../shared/types'
import { errorMessage } from './errors'
import { useConversations } from './useConversations'

function saved<T>(key: string): Record<string, T> {
  try {
    return JSON.parse(localStorage.getItem(key) ?? '{}') ?? {}
  } catch {
    return {}
  }
}

function forget<T>(current: Record<string, T>, id: string): Record<string, T> {
  if (!Object.hasOwn(current, id)) return current
  const next = { ...current }
  delete next[id]
  return next
}

export function App() {
  const conversations = useConversations()
  const [unread, setUnread] = useState(() => saved<number>('agentsync-unread'))
  const [recipients, setRecipients] = useState(() => saved<SendTarget>('agentsync-recipients'))
  useEffect(() => { localStorage.setItem('agentsync-unread', JSON.stringify(unread)) }, [unread])
  useEffect(() => { localStorage.setItem('agentsync-recipients', JSON.stringify(recipients)) }, [recipients])
  const [panes, setPanes] = useState<ConversationPane[]>([{ key: 0, id: null }])
  const visible = useRef(panes)
  visible.current = panes
  const [panel, setPanel] = useState<'connections' | 'usage' | null>(null)
  const obscured = useRef(false)
  obscured.current = panel !== null
  useEffect(() => window.agentsync.onEvent(({ conversationId, event }) => {
    if (event.type !== 'message:update' || event.message.status !== 'done') return
    if (event.message.from !== 'gpt' && event.message.from !== 'claude') return
    if (document.hasFocus() && !document.hidden && !obscured.current && visible.current.some((pane) => pane.id === conversationId)) return
    setUnread((current) => ({ ...current, [conversationId]: (current[conversationId] ?? 0) + 1 }))
  }), [])

  useEffect(() => {
    const markVisible = () => {
      if (!document.hasFocus() || document.hidden || panel) return
      setUnread((current) => {
        const opened = panes.flatMap(({ id }) => id && current[id] ? [id] : [])
        if (!opened.length) return current
        const next = { ...current }
        for (const id of opened) delete next[id]
        return next
      })
    }
    markVisible()
    window.addEventListener('focus', markVisible)
    document.addEventListener('visibilitychange', markVisible)
    return () => {
      window.removeEventListener('focus', markVisible)
      document.removeEventListener('visibilitychange', markVisible)
    }
  }, [panes, panel])

  const [selected, setSelected] = useState(0)
  const selectedRef = useRef(selected)
  selectedRef.current = selected
  const nextKey = useRef(1)
  const [ratio, setRatio] = useState(50)
  const activeId = panes.find((pane) => pane.key === selected)?.id ?? null
  const setActiveId = useCallback((id: string | null, key = selectedRef.current) => {
    setPanes((current) => selectConversation(current, key, id))
  }, [])
  const paneContainer = useRef<HTMLDivElement>(null)
  const split = panes.length === 2
  const toggleSplit = () => {
    if (split) setPanes((current) => keepPane(current, selected))
    else {
      const key = nextKey.current++
      const scrollTop = paneContainer.current?.querySelector('.timeline')?.scrollTop ?? 0
      setPanes((current) => splitPane(current, key, scrollTop))
      setRatio(50)
    }
  }
  const resize = (value: number) => setRatio(Math.min(75, Math.max(25, value)))
  // Which list the sidebar shows: chats or coding conversations. Follows the open conversation.
  const [mode, setMode] = useState<ConversationKind>('chat')
  const activeKind = conversations?.find((c) => c.id === activeId)?.kind
  useEffect(() => {
    if (activeKind) setMode(activeKind)
  }, [activeId, activeKind])
  const started = useRef(false)

  const createConversation = useCallback(() => {
    const key = selectedRef.current
    void window.agentsync.createConversation().then((id) => setActiveId(id, key), (error: unknown) => console.error(errorMessage(error)))
  }, [setActiveId])

  const createCodeConversation = useCallback(() => {
    const key = selectedRef.current
    void window.agentsync.createCodeConversation().then(
      (id) => {
        if (id) setActiveId(id, key)
      },
      (error: unknown) => console.error(errorMessage(error)),
    )
  }, [setActiveId])

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
        if (!deleted) return
        setUnread((current) => forget(current, id))
        setRecipients((current) => forget(current, id))
        setPanes((current) => current.map((pane) => pane.id === id ? { ...pane, id: remaining[0]?.id ?? null } : pane))
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
        unread={unread}
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
      <div className={`chat-workspace${split ? ' is-split' : ''}`}>
        <div className="workspace-toolbar">
          <button type="button" className="split-toggle" aria-label={split ? '1画面に戻す' : '2画面で表示'} title={split ? '選択中の画面を残して1画面に戻す' : '2画面で表示'} aria-pressed={split} onClick={toggleSplit}>
            <SplitIcon size={19} />
          </button>
        </div>
        <div className="chat-panes" ref={paneContainer}>
          {panes.map((pane, index) => (
            <div key={pane.key} className="pane-slot" style={{ flex: split ? `${index === 0 ? ratio : 100 - ratio} 1 0` : '1 1 0' }}>
              {index === 1 && (
                <div className="pane-divider" role="separator" aria-label="左右の幅を調整" aria-orientation="vertical" aria-valuemin={25} aria-valuemax={75} aria-valuenow={Math.round(ratio)} tabIndex={0}
                  onPointerDown={(event) => event.currentTarget.setPointerCapture(event.pointerId)}
                  onPointerMove={(event) => {
                    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
                    const rect = event.currentTarget.closest('.chat-panes')!.getBoundingClientRect()
                    resize((event.clientX - rect.left) / rect.width * 100)
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
                      event.preventDefault()
                      resize(ratio + (event.key === 'ArrowRight' ? 2 : -2))
                    }
                  }}
                />
              )}
              <section key="conversation" className={`chat-pane${selected === pane.key ? ' selected' : ''}`} aria-label={index === 0 ? '左の画面' : '右の画面'} onPointerDownCapture={() => setSelected(pane.key)} onFocusCapture={() => setSelected(pane.key)}>
                {split && (
                  <select className="pane-conversation" aria-label="表示するスレッド" value={pane.id ?? ''} onChange={(event) => {
                    const id = event.target.value
                    setPanes((current) => selectConversation(current, pane.key, id))
                  }}>
                    {!pane.id && <option value="" disabled>スレッドを選択</option>}
                    {conversations.map((conversation) => <option key={conversation.id} value={conversation.id}>{conversation.title}</option>)}
                  </select>
                )}
                {pane.id ? (
                  <ChatView key={pane.id} conversationId={pane.id}
                    recipient={recipients[pane.id] ?? 'all'}
                    onRecipient={(to) => {
                      const id = pane.id!
                      setRecipients((current) => ({ ...current, [id]: to }))
                    }}
                    active={selected === pane.key} independentScroll={split} initialScrollTop={pane.initialScrollTop} />
                ) : (
                  <main className="chat chat-blank"><div className="empty"><h2>会話を選ぶか、新しく始めましょう</h2><button type="button" className="new-conversation" onClick={mode === 'code' ? createCodeConversation : createConversation}>新しい会話…</button></div></main>
                )}
              </section>
            </div>
          ))}
        </div>
      </div>
      {panel === 'connections' && <ConnectionsPanel onClose={() => setPanel(null)} />}
      {panel === 'usage' && <UsagePanel onClose={() => setPanel(null)} />}
    </div>
  )
}
