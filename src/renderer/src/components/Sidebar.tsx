import { useState } from 'react'
import type { ConversationSummary } from '../../../shared/types'
import { LoopIcon, MoreIcon, PencilIcon, PlusIcon, TrashIcon } from './icons'
import { PopupMenu } from './PopupMenu'
import { TitleInput } from './TitleInput'

interface SidebarProps {
  conversations: ConversationSummary[]
  activeId: string | null
  onSelect(id: string): void
  onCreate(): void
  onRename(id: string, title: string): void
  onDelete(id: string): void
}

/** The open 「…」 menu: which conversation, and where (window coordinates). */
interface MenuState {
  id: string
  x: number
  y: number
  /** The 「…」 button that opened it; focus goes back there when the menu is closed with the keyboard. */
  trigger: HTMLElement | null
}

const GROUPS = ['今日', '昨日', '過去 7 日間', 'それ以前'] as const

function groupOf(iso: string, now: Date): (typeof GROUPS)[number] {
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const time = new Date(iso).getTime()
  const day = 24 * 60 * 60 * 1000
  if (time >= startOfToday) return '今日'
  if (time >= startOfToday - day) return '昨日'
  if (time >= startOfToday - 6 * day) return '過去 7 日間'
  return 'それ以前'
}

export function Sidebar({ conversations, activeId, onSelect, onCreate, onRename, onDelete }: SidebarProps) {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const now = new Date()
  const grouped = GROUPS.map((label) => ({
    label,
    items: conversations.filter((c) => groupOf(c.updatedAt, now) === label),
  })).filter((group) => group.items.length > 0)

  const toggleMenu = (id: string, button: HTMLElement) => {
    if (menu?.id === id) {
      setMenu(null)
      return
    }
    const rect = button.getBoundingClientRect()
    setMenu({ id, x: rect.left, y: rect.bottom + 4, trigger: button })
  }

  return (
    <nav className="sidebar" aria-label="会話一覧">
      <div className="brand">AgentSync</div>
      <button type="button" className="new-conversation" onClick={onCreate}>
        <PlusIcon />
        新しい会話
        <kbd>⌘N</kbd>
      </button>
      <div className="conversations">
        {grouped.map((group) => (
          <section key={group.label} className="conversation-group" aria-label={group.label}>
            <h2>{group.label}</h2>
            <ul>
              {group.items.map((conversation) => {
                const { id, title } = conversation
                const active = id === activeId
                const classes = ['conversation', active && 'conversation-active', menu?.id === id && 'conversation-menu-open']
                return (
                  <li
                    key={id}
                    className={classes.filter(Boolean).join(' ')}
                    onContextMenu={(event) => {
                      event.preventDefault()
                      if (editingId !== id) setMenu({ id, x: event.clientX, y: event.clientY, trigger: null })
                    }}
                  >
                    {editingId === id ? (
                      <TitleInput
                        initial={title}
                        className="conversation-rename"
                        onDone={(next) => {
                          setEditingId(null)
                          if (next) onRename(id, next)
                        }}
                      />
                    ) : (
                      <>
                        <button
                          type="button"
                          className="conversation-open"
                          aria-current={active ? 'page' : undefined}
                          title={`${title}（ダブルクリックで名前を変更）`}
                          onClick={() => onSelect(id)}
                          onDoubleClick={() => setEditingId(id)}
                        >
                          <span className="conversation-title">{title}</span>
                          {conversation.dialogue ? (
                            <span className="conversation-dialogue" role="img" aria-label="対話中" title="対話中">
                              <LoopIcon size={14} />
                            </span>
                          ) : (
                            conversation.busy && <span className="conversation-busy" aria-label="返信中" />
                          )}
                        </button>
                        <button
                          type="button"
                          className="conversation-more"
                          aria-label={`「${title}」のメニュー`}
                          title="名前の変更・削除"
                          aria-haspopup="menu"
                          aria-expanded={menu?.id === id}
                          // Keep the open menu's 「click elsewhere」 handling from closing it first; this button toggles it.
                          onMouseDown={(event) => event.stopPropagation()}
                          onClick={(event) => toggleMenu(id, event.currentTarget)}
                        >
                          <MoreIcon />
                        </button>
                      </>
                    )}
                  </li>
                )
              })}
            </ul>
          </section>
        ))}
      </div>
      {menu && (
        <PopupMenu
          key={`${menu.id}:${menu.x}:${menu.y}`}
          x={menu.x}
          y={menu.y}
          label="会話のメニュー"
          onClose={(restoreFocus) => {
            setMenu(null)
            if (restoreFocus) menu.trigger?.focus()
          }}
        >
          <button
            type="button"
            role="menuitem"
            className="menu-item"
            onClick={() => {
              setMenu(null)
              setEditingId(menu.id)
            }}
          >
            <PencilIcon />
            名前を変更
          </button>
          <button
            type="button"
            role="menuitem"
            className="menu-item menu-danger"
            onClick={() => {
              setMenu(null)
              onDelete(menu.id) // the main process asks for confirmation
            }}
          >
            <TrashIcon />
            削除…
          </button>
        </PopupMenu>
      )}
    </nav>
  )
}
