import { useEffect, useState } from 'react'
import { AGENT_IDS, DISPLAY_NAMES, type AgentChoices, type AgentId, type AgentInfo } from '../../../shared/types'
import { isModel } from '../../../shared/validate'
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
  onModel(agent: AgentId, model: string | null): void
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

/** The conversation title (click to rename) and the participants: model, effort and what each is doing. */
export function Header({ title, agents, onRename, loadChoices, onModel, onEffort }: HeaderProps) {
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
          const model = agent.activeModel ?? agent.model
          return (
            <button
              key={id}
              type="button"
              className="participant"
              aria-haspopup="menu"
              aria-expanded={menu?.agent === id}
              title={`${DISPLAY_NAMES[id]} のモデルと考える深さ（effort）を変える`}
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
              {model && <span className="participant-model">{model}</span>}
              <span className="participant-effort">{agent.effort ?? '自動'}</span>
              {agent.busy && <span className="participant-busy">{ACTIVITY_LABELS[agent.activity?.kind ?? 'thinking']}…</span>}
              <ChevronDownIcon size={14} className="participant-chevron" />
            </button>
          )
        })}
      </div>
      {menu && (
        <AgentMenu
          key={menu.agent}
          agent={agents[menu.agent]}
          x={menu.x}
          y={menu.y}
          loadChoices={loadChoices}
          onModel={(model) => {
            setMenu(null)
            menu.trigger.focus()
            if (model !== agents[menu.agent].model) onModel(menu.agent, model)
          }}
          onEffort={(effort) => {
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

interface AgentMenuProps {
  agent: AgentInfo
  x: number
  y: number
  loadChoices(agent: AgentId): Promise<AgentChoices>
  onModel(model: string | null): void
  onEffort(effort: string | null): void
  onClose(restoreFocus: boolean): void
}

/**
 * The models the agent's CLI offers and the efforts its current model accepts, each with 「自動」 (the CLI's own
 * setting) first. Claude Code takes any model ID, so one can be typed in.
 */
function AgentMenu({ agent, x, y, loadChoices, onModel, onEffort, onClose }: AgentMenuProps) {
  const [choices, setChoices] = useState<AgentChoices | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [typing, setTyping] = useState(false)
  const name = DISPLAY_NAMES[agent.id]

  useEffect(() => {
    let active = true
    loadChoices(agent.id).then(
      (result) => active && setChoices(result),
      (reason: unknown) => active && setError(errorMessage(reason)),
    )
    return () => {
      active = false
    }
  }, [agent.id, loadChoices])

  // `idHint`: the hint is a model ID, shown in the code font.
  const radio = (key: string, checked: boolean, label: string, hint: string | null, onSelect: () => void, title?: string, idHint = false) => (
    <button key={key} type="button" role="menuitemradio" aria-checked={checked} className="menu-item" title={title} onClick={onSelect}>
      <CheckIcon className="menu-check" />
      <span className="menu-label">{label}</span>
      {hint && (
        <span className={idHint ? 'menu-hint menu-hint-id' : 'menu-hint'} title={hint}>
          {hint}
        </span>
      )}
    </button>
  )
  const listed = choices?.models ?? []
  // A model chosen earlier (or typed in) that the CLI does not list.
  const unlisted = agent.model !== null && !listed.some((m) => m.value === agent.model) ? agent.model : null

  return (
    <PopupMenu x={x} y={y} align="end" label={`${name} の設定`} className="agent-menu" onClose={onClose}>
      {!choices && !error && <div className="menu-status">読み込み中…</div>}
      {error && (
        <div className="menu-status menu-error" role="alert">
          {error}
        </div>
      )}
      {choices && (
        <>
          <div role="group" aria-label="モデル">
            <div className="menu-heading">{name} のモデル</div>
            {radio('auto', agent.model === null, '自動', choices.defaultModel ? `CLI の設定（${choices.defaultModel}）` : 'CLI の設定のまま', () => onModel(null))}
            {listed.map((m) =>
              radio(m.value, agent.model === m.value, m.label, m.label === m.value ? null : m.value, () => onModel(m.value), m.description ?? undefined, true),
            )}
            {unlisted && radio(unlisted, true, unlisted, '指定中', () => onModel(unlisted))}
            {choices.customModel &&
              (typing ? (
                <ModelIdInput onDone={(model) => onModel(model)} />
              ) : (
                <button type="button" role="menuitem" className="menu-item" onClick={() => setTyping(true)}>
                  <span className="menu-check" />
                  <span className="menu-label">ほかのモデル ID を入力…</span>
                </button>
              ))}
          </div>
          <div className="menu-separator" role="separator" />
          <div role="group" aria-label="考える深さ">
            <div className="menu-heading">考える深さ（effort）</div>
            {choices.efforts.length === 0 ? (
              <div className="menu-status">このモデルでは選べません</div>
            ) : (
              <>
                {radio('auto', agent.effort === null, '自動', choices.defaultEffort ? `CLI の設定（${choices.defaultEffort}）` : 'CLI の設定のまま', () =>
                  onEffort(null),
                )}
                {choices.efforts.map((effort) => radio(effort, agent.effort === effort, effort, EFFORT_HINTS[effort] ?? null, () => onEffort(effort)))}
              </>
            )}
          </div>
        </>
      )}
      <p className="menu-note">次の返事から変わります。新しい会話にも引き継ぎます。</p>
    </PopupMenu>
  )
}

/** Types a model ID that Claude Code accepts but does not list (e.g. an older model). Enter chooses it. */
function ModelIdInput({ onDone }: { onDone(model: string): void }) {
  const [value, setValue] = useState('')
  const [invalid, setInvalid] = useState(false)
  return (
    <div className="menu-input">
      <input
        autoFocus
        aria-label="モデル ID"
        placeholder="例: claude-sonnet-5-5"
        spellCheck={false}
        value={value}
        onChange={(event) => {
          setValue(event.target.value)
          setInvalid(false)
        }}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' || event.nativeEvent.isComposing || event.keyCode === 229) return
          event.preventDefault()
          const model = value.trim()
          if (isModel(model)) onDone(model)
          else setInvalid(true)
        }}
      />
      <span className={invalid ? 'menu-input-note menu-error' : 'menu-input-note'}>
        {invalid ? '英数字と . _ : / @ [ ] - で書いてください' : 'Enter で決定'}
      </span>
    </div>
  )
}
