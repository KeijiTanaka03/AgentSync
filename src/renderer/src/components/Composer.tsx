import { useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { AGENT_IDS, DISPLAY_NAMES, otherAgent, type AgentId, type ApprovalMode, type SendTarget } from '../../../shared/types'
import { parseLeadingMention } from '../../../shared/validate'
import { CodeIcon, LoopIcon } from './icons'
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
  canStartReview?: boolean
  /** Starts 実装＋レビュー with this implementer (with the request typed in, if any), or stops it with null. */
  onReview?(implementer: AgentId | null, task?: string): void
  /** What you sent before, oldest first: ↑ / ↓ go through it. */
  history?: string[]
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
  canStartReview = false,
  onReview,
  history = [],
}: ComposerProps) {
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

  const show = (value: string) => {
    setText(value)
    requestAnimationFrame(() => {
      resize()
      const element = box.current
      if (element) element.selectionStart = element.selectionEnd = value.length
    })
  }

  /**
   * ↑ on the first line: the message sent before (again for older ones). ↓ on the last line: newer ones,
   * then back to your draft. Elsewhere the arrows move the caret as usual.
   */
  const recall = (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    const element = event.currentTarget
    if (element.selectionStart !== element.selectionEnd) return false
    const onFirstLine = !text.slice(0, element.selectionStart).includes('\n')
    const onLastLine = !text.slice(element.selectionEnd).includes('\n')
    if (event.key === 'ArrowUp' && onFirstLine && history.length > 0) {
      if (recalled === 0) return true
      const index = recalled === null ? history.length - 1 : Math.max(0, recalled - 1)
      if (recalled === null) draft.current = text
      setRecalled(index)
      show(history[index]!)
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
    if ((event.key === 'ArrowUp' || event.key === 'ArrowDown') && !event.shiftKey && !event.altKey && !event.metaKey) {
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
              onClick={() => setTo(target.id)}
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
              <button type="button" aria-pressed={approvalMode === 'auto'} title="確認せずに進めます（各 CLI の auto モード）。作業ブランチで使ってください" onClick={() => onApprovalMode('auto')}>
                auto
              </button>
            </div>
          )}
          {onReview && (
            <button
              type="button"
              className="dialogue-toggle"
              aria-pressed={reviewing}
              aria-haspopup={reviewing ? undefined : 'menu'}
              disabled={!reviewing && ((!canStartReview && !text.trim()) || dialogue)}
              title={
                reviewing
                  ? 'もう一度押すと実装＋レビューを止めます'
                  : '入力欄の依頼（空なら直前の依頼）を、片方が実装し、もう片方がレビューします'
              }
              onMouseDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                if (reviewing) onReview(null)
                else if (reviewMenu) setReviewMenu(null)
                else {
                  const rect = event.currentTarget.getBoundingClientRect()
                  setReviewMenu({ x: rect.right, y: rect.top - 6, trigger: event.currentTarget })
                }
              }}
            >
              <CodeIcon size={15} />
              実装＋レビュー{reviewing ? ' ON' : ''}
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
        <label htmlFor="message" className="visually-hidden">
          メッセージ
        </label>
        <textarea
          id="message"
          ref={box}
          rows={1}
          value={text}
          placeholder={dialogue ? '割り込んで発言…（対話は止めずに次の話者へ渡します）' : 'メッセージを入力…（Enter で送信、Shift+Enter で改行）'}
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
      {reviewMenu && onReview && (
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
          <div className="menu-heading">{text.trim() ? '入力欄の依頼' : '直前の依頼'}を、だれが実装しますか</div>
          {AGENT_IDS.map((implementer) => (
            <button
              key={implementer}
              type="button"
              role="menuitem"
              className="menu-item"
              onClick={() => {
                setReviewMenu(null)
                const task = text.trim()
                onReview(implementer, task || undefined)
                if (task) {
                  setText('')
                  requestAnimationFrame(resize)
                }
              }}
            >
              <span className="menu-label">
                {DISPLAY_NAMES[implementer]} が実装 → {DISPLAY_NAMES[otherAgent(implementer)]} がレビュー
              </span>
            </button>
          ))}
          <p className="menu-note">レビュー役が APPROVED と返すか、3 往復で止まります。実装役だけがファイルを変更できます。</p>
        </PopupMenu>
      )}
    </form>
  )
}
