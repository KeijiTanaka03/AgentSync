import { useEffect, useState } from 'react'
import { AGENT_IDS, DISPLAY_NAMES, type AgentChoices, type AgentId, type AgentInfo } from '../../../shared/types'
import { errorMessage } from '../errors'
import { ACTIVITY_LABELS } from './Activity'
import { Avatar } from './Avatar'
import { CheckIcon, ChevronDownIcon, PencilIcon } from './icons'
import { PopupMenu } from './PopupMenu'
import { TitleInput } from './TitleInput'

interface HeaderProps {
  title: string
  agents: Record<AgentId, AgentInfo>
  onRename(title: string): void
  loadChoices(agent: AgentId): Promise<AgentChoices>
  onEffort(agent: AgentId, effort: string | null): void
}

/** A word on what each effort means, for the names the CLIs use today. */
const EFFORT_HINTS: Record<string, string> = {
  none: '考えない',
  minimal: 'いちばん速い',
  low: '速い',
  medium: 'ふつう',
  high: 'じっくり',
  xhigh: 'もっとじっくり',
  max: 'とことん',
  ultra: '最大',
}

/** The conversation title (click to rename) and the participants: what each is doing, and how hard it thinks. */
export function Header({ title, agents, onRename, loadChoices, onEffort }: HeaderProps) {
  const [editing, setEditing] = useState(false)
  const [menu, setMenu] = useState<{ agent: AgentId; x: number; y: number; trigger: HTMLElement } | null>(null)

  return (
    <header className="header">
      <div className="header-title">
        {editing ? (
          <TitleInput
            initial={title}
            className="title-input"
            onDone={(next) => {
              setEditing(false)
              if (next) onRename(next)
            }}
          />
        ) : (
          <h1>
            <button type="button" className="title-button" title="クリックして名前を変更" onClick={() => setEditing(true)}>
              <span className="title-text">{title}</span>
              <PencilIcon size={15} className="title-edit" />
            </button>
          </h1>
        )}
      </div>
      <div className="participants">
        {AGENT_IDS.map((id) => {
          const agent = agents[id]
          return (
            <button
              key={id}
              type="button"
              className="participant"
              aria-haspopup="menu"
              aria-expanded={menu?.agent === id}
              title={`${DISPLAY_NAMES[id]} の考える深さ（effort）を変える`}
              // Keep an open menu's 「click elsewhere」 handling from closing it first; this button toggles it.
              onMouseDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                if (menu?.agent === id) {
                  setMenu(null)
                  return
                }
                const rect = event.currentTarget.getBoundingClientRect()
                setMenu({ agent: id, x: rect.right, y: rect.bottom + 6, trigger: event.currentTarget })
              }}
            >
              <Avatar agent={id} size="sm" />
              <span className="participant-name">{DISPLAY_NAMES[id]}</span>
              {agent.model && <span className="participant-model">{agent.model}</span>}
              <span className="participant-effort">{agent.effort ?? '自動'}</span>
              {agent.busy && <span className="participant-busy">{ACTIVITY_LABELS[agent.activity?.kind ?? 'thinking']}…</span>}
              <ChevronDownIcon size={14} className="participant-chevron" />
            </button>
          )
        })}
      </div>
      {menu && (
        <EffortMenu
          key={menu.agent}
          agent={menu.agent}
          effort={agents[menu.agent].effort}
          x={menu.x}
          y={menu.y}
          loadChoices={loadChoices}
          onChoose={(effort) => {
            setMenu(null)
            menu.trigger.focus()
            if (effort !== agents[menu.agent].effort) onEffort(menu.agent, effort)
          }}
          onClose={(restoreFocus) => {
            setMenu(null)
            if (restoreFocus) menu.trigger.focus()
          }}
        />
      )}
    </header>
  )
}

interface EffortMenuProps {
  agent: AgentId
  effort: string | null
  x: number
  y: number
  loadChoices(agent: AgentId): Promise<AgentChoices>
  onChoose(effort: string | null): void
  onClose(restoreFocus: boolean): void
}

/** Lists the efforts the agent's CLI accepts for its model, with 「自動」 (the CLI's own setting) first. */
function EffortMenu({ agent, effort, x, y, loadChoices, onChoose, onClose }: EffortMenuProps) {
  const [choices, setChoices] = useState<AgentChoices | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    loadChoices(agent).then(
      (result) => active && setChoices(result),
      (reason: unknown) => active && setError(errorMessage(reason)),
    )
    return () => {
      active = false
    }
  }, [agent, loadChoices])

  const item = (value: string | null, label: string, hint: string | undefined) => (
    <button
      key={value ?? 'auto'}
      type="button"
      role="menuitemradio"
      aria-checked={effort === value}
      className="menu-item"
      onClick={() => onChoose(value)}
    >
      <CheckIcon className="menu-check" />
      <span>{label}</span>
      {hint && <span className="menu-hint">{hint}</span>}
    </button>
  )

  return (
    <PopupMenu x={x} y={y} align="end" label={`${DISPLAY_NAMES[agent]} の考える深さ`} className="effort-menu" onClose={onClose}>
      <div className="menu-heading">{DISPLAY_NAMES[agent]} の考える深さ（effort）</div>
      {!choices && !error && <div className="menu-status">読み込み中…</div>}
      {error && (
        <div className="menu-status menu-error" role="alert">
          {error}
        </div>
      )}
      {choices && (
        <>
          {item(null, '自動', choices.defaultEffort ? `CLI の設定（${choices.defaultEffort}）` : 'CLI の設定のまま')}
          {choices.efforts.map((name) => item(name, name, EFFORT_HINTS[name]))}
        </>
      )}
      <p className="menu-note">次の返事から変わります。新しい会話にも引き継ぎます。</p>
    </PopupMenu>
  )
}
