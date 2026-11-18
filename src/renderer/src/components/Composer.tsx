import { useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { AGENT_IDS, DISPLAY_NAMES, isAgentId, otherAgent, type ApprovalMode, type Roles, type SendTarget } from '../../../shared/types'
import { parseLeadingMention } from '../../../shared/validate'
import { CheckIcon, CodeIcon, LoopIcon } from './icons'
import { PopupMenu } from './PopupMenu'

const TARGETS: { id: SendTarget; label: string }[] = [
  { id: 'all', label: '全員' },
  { id: 'claude', label: DISPLAY_NAMES.claude },
  { id: 'gpt', label: DISPLAY_NAMES.gpt },
]

const MAX_HEIGHT = 220

interface ComposerProps {
  busy: boolean
  /** Dialogue mode is on. */
  dialogue: boolean
  /** There is something to talk about (dialogue mode needs a topic). */
  canStartDialogue: boolean
  onSend(text: string, to: SendTarget): void
  onStop(): void
  onToggleDialogue(): void
  /** Coding conversations: how edits and commands are allowed. */
  approvalMode?: ApprovalMode
  onApprovalMode?(mode: ApprovalMode): void
  /** Coding conversations: 実装＋レビュー is running. */
  reviewing?: boolean
  onStopReview?(): void
  /** What you sent before, oldest first: ↑ / ↓ go through it. */
  history?: string[]
  /** Coding: who may change the project. Choosing an implementer makes the next request a 実装＋レビュー. */
  roles?: Roles
  onRoles?(roles: Roles): void
}

export function Composer({
  busy,
  dialogue,
  canStartDialogue,
  onSend,
  onStop,
  onToggleDialogue,
  approvalMode,
  onApprovalMode,
  reviewing = false,
  onStopReview,
  history = [],
  roles = 'single',
  onRoles,
}: ComposerProps) {
  const messageId = useId()
  const implementer = isAgentId(roles) ? roles : null
  const [to, setTo] = useState<SendTarget>('all')
  // ↑ / ↓: which earlier message is shown (null: your own draft), and the draft kept meanwhile.
  const [recalled, setRecalled] = useState<number | null>(null)
  const draft = useRef('')
  const [reviewMenu, setReviewMenu] = useState<{ x: number; y: number; trigger: HTMLElement } | null>(null)
  const [text, setText] = useState('')
  const box = useRef<HTMLTextAreaElement>(null)

  const resize = () => {
    const element = box.current
    if (!element) return
    element.style.height = 'auto'
    element.style.height = `${Math.min(element.scrollHeight, MAX_HEIGHT)}px`
  }

  const submit = () => {
    let target = to
    let body = text
    const mention = parseLeadingMention(text)
    if (mention) {
      target = mention.to
      body = mention.text
      setTo(mention.to)
    }
    if (!body.trim()) return
    onSend(body, target)
    setText('')
    setRecalled(null)
    requestAnimationFrame(resize)
  }

  const onSubmit = (event: FormEvent) => {
    event.preventDefault()
    submit()
  }

  const show = (value: string, atStart = false) => {
    setText(value)
    requestAnimationFrame(() => {
      resize()
      const element = box.current
      if (element) element.selectionStart = element.selectionEnd = atStart ? 0 : value.length
    })
  }

  /**
   * ↑ first moves to the start of the draft; only at position zero does it recall history.
   * ↓ on the last line recalls newer messages, then restores the saved draft.
   */
  const recall = (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    const element = event.currentTarget
    if (element.selectionStart !== element.selectionEnd) return false
    const onLastLine = !text.slice(element.selectionEnd).includes('\n')
    if (event.key === 'ArrowUp' && element.selectionStart > 0) {
      element.setSelectionRange(0, 0)
      element.scrollTop = 0
      return true
    }
    if (event.key === 'ArrowUp' && element.selectionStart === 0 && history.length > 0) {
      if (recalled === 0) return true
      const index = recalled === null ? history.length - 1 : Math.max(0, recalled - 1)
      if (recalled === null) draft.current = text
      setRecalled(index)
      show(history[index]!, true)
      return true
    }
    if (event.key === 'ArrowDown' && recalled !== null && onLastLine) {
      const index = recalled + 1
      if (index >= history.length) {
        setRecalled(null)
        show(draft.current)
      } else {
        setRecalled(index)
        show(history[index]!)
      }
      return true
    }
    return false
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return
    if ((event.key === 'ArrowUp' || event.key === 'ArrowDown') && !event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey) {
      if (recall(event)) event.preventDefault()
      return
    }
    // Enter sends; Shift+Enter adds a line. Never send while an IME is composing.
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing || event.keyCode === 229) return
    event.preventDefault()
    submit()
  }

  return (
    <form className="composer" onSubmit={onSubmit}>
      <div className="composer-top">
        <div className="targets" role="group" aria-label="宛先">
          <span className="targets-label">宛先</span>
          {TARGETS.map((target) => (
            <button
              key={target.id}
              type="button"
              className={`chip chip-${target.id}`}
              aria-pressed={to === target.id}
              onClick={() => {
                setTo(target.id)
                // Addressing one AI means a plain request, so a chosen 実装＋レビュー is cleared.
                if (target.id !== 'all' && implementer && !reviewing) onRoles?.('single')
              }}
            >
              {target.label}
            </button>
          ))}
        </div>
        <div className="composer-actions">
          {approvalMode && onApprovalMode && (
            <div className="approval-toggle" role="group" aria-label="承認の方式">
              <button type="button" aria-pressed={approvalMode === 'ask'} title="ファイルの編集とコマンドの実行の前に、毎回確認します" onClick={() => onApprovalMode('ask')}>
                承認制
              </button>
              <button type="button" aria-pressed={approvalMode === 'auto'} title="作業フォルダ外の変更や外部操作も確認なしで進めます" onClick={() => onApprovalMode('auto')}>
                auto
              </button>
            </div>
          )}
          {onRoles && (
            <button
              type="button"
              className="dialogue-toggle"
              aria-pressed={reviewing || roles !== 'single'}
              aria-haspopup={reviewing ? undefined : 'menu'}
              title={
                reviewing
                  ? 'もう一度押すと実装＋レビューを止めます'
                  : implementer
                    ? `依頼を送ると、${DISPLAY_NAMES[implementer]} が実装し、${DISPLAY_NAMES[otherAgent(implementer)]} がレビューします。押すと役割を選び直せます`
                    : '役割を選びます: 片方が実装し、もう片方がレビュー'
              }
              onMouseDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                if (reviewing) onStopReview?.()
                else if (reviewMenu) setReviewMenu(null)
                else {
                  const rect = event.currentTarget.getBoundingClientRect()
                  setReviewMenu({ x: rect.right, y: rect.top - 6, trigger: event.currentTarget })
                }
              }}
            >
              <CodeIcon size={15} />
              {reviewing
                ? '実装＋レビュー ON'
                : implementer
                  ? `${DISPLAY_NAMES[implementer]} が実装 → ${DISPLAY_NAMES[otherAgent(implementer)]} がレビュー`
                  : '実装＋レビュー'}
            </button>
          )}
          <button
            type="button"
            className="dialogue-toggle"
            aria-pressed={dialogue}
            disabled={!dialogue && (!canStartDialogue || reviewing)}
            title={
              dialogue
                ? 'もう一度押すと対話モードを止めます'
                : canStartDialogue
                  ? 'Claude と GPT が交互に話し続けます（止めるまで）'
                  : 'まず話題を送ってください'
            }
            onClick={onToggleDialogue}
          >
            <LoopIcon size={15} />
            対話モード{dialogue ? ' ON' : ''}
          </button>
          {busy && (
            <button type="button" className="stop" onClick={onStop}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <rect x="4" y="4" width="16" height="16" rx="2" />
              </svg>
              停止
            </button>
          )}
        </div>
      </div>
      <div className="composer-bottom">
        <label htmlFor={messageId} className="visually-hidden">
          メッセージ
        </label>
        <textarea
          id={messageId}
          ref={box}
          rows={1}
          value={text}
          placeholder={
            dialogue
              ? '割り込んで発言…（対話は止めずに次の話者へ渡します）'
              : implementer && !reviewing
                ? `依頼を入力…（送ると ${DISPLAY_NAMES[implementer]} が実装し、${DISPLAY_NAMES[otherAgent(implementer)]} がレビューします）`
                : 'メッセージを入力…（Enter で送信、Shift+Enter で改行）'
          }
          onChange={(event) => {
            setText(event.target.value)
            setRecalled(null)
            resize()
          }}
          onKeyDown={onKeyDown}
        />
        <button type="submit" className="send" aria-label="送信" data-testid="send" disabled={!text.trim()}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 19V5M5 12l7-7 7 7" />
          </svg>
        </button>
      </div>
      {reviewMenu && onRoles && (
        <PopupMenu
          x={reviewMenu.x}
          y={reviewMenu.y}
          align="end"
          label="実装＋レビューの役割"
          className="review-menu"
          onClose={(restoreFocus) => {
            setReviewMenu(null)
            if (restoreFocus) reviewMenu.trigger.focus()
          }}
        >
          <div className="menu-heading">役割</div>
          {AGENT_IDS.map((choice) => (
            <button
              key={choice}
              type="button"
              role="menuitemradio"
              aria-checked={roles === choice}
              className="menu-item"
              onClick={() => {
                setReviewMenu(null)
                onRoles(roles === choice ? 'single' : choice)
              }}
            >
              <CheckIcon className="menu-check" />
              <span className="menu-label">
                {DISPLAY_NAMES[choice]} が実装 → {DISPLAY_NAMES[otherAgent(choice)]} がレビュー
              </span>
            </button>
          ))}
          <p className="menu-note">
            実装役を選ぶと、次に送る依頼から実装＋レビューが始まります（レビュー役が APPROVED と返すか 3 往復で終了）。同じ役割をもう一度選ぶと解除です。
          </p>
        </PopupMenu>
      )}
    </form>
  )
}
