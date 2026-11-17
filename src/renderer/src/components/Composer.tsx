import { useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { DISPLAY_NAMES, type SendTarget } from '../../../shared/types'
import { parseLeadingMention } from '../../../shared/validate'
import { LoopIcon } from './icons'

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
}

export function Composer({ busy, dialogue, canStartDialogue, onSend, onStop, onToggleDialogue }: ComposerProps) {
  const [to, setTo] = useState<SendTarget>('all')
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
    requestAnimationFrame(resize)
  }

  const onSubmit = (event: FormEvent) => {
    event.preventDefault()
    submit()
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
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
          <button
            type="button"
            className="dialogue-toggle"
            aria-pressed={dialogue}
            disabled={!dialogue && !canStartDialogue}
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
    </form>
  )
}
