import { useRef, useState, type KeyboardEvent } from 'react'
import { MAX_TITLE_LENGTH } from '../../../shared/types'

interface TitleInputProps {
  initial: string
  className: string
  /** Called once: with the new title, or null when it is unchanged, empty or the edit was cancelled. */
  onDone(title: string | null): void
}

/** Edits a conversation name in place. Enter or clicking away saves; Escape cancels. */
export function TitleInput({ initial, className, onDone }: TitleInputProps) {
  const [draft, setDraft] = useState(initial)
  // Escape closes the input, and the input losing focus must not then save it.
  const finished = useRef(false)

  const finish = (save: boolean) => {
    if (finished.current) return
    finished.current = true
    const next = draft.replace(/\s+/g, ' ').trim()
    onDone(save && next !== '' && next !== initial ? next : null)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    // Enter also confirms an IME conversion; that must not save yet.
    if (event.nativeEvent.isComposing || event.keyCode === 229) return
    if (event.key === 'Enter') {
      event.preventDefault()
      finish(true)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      finish(false)
    }
  }

  return (
    <input
      className={className}
      aria-label="会話の名前"
      autoFocus
      maxLength={MAX_TITLE_LENGTH}
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onFocus={(event) => event.target.select()}
      onBlur={() => finish(true)}
      onKeyDown={onKeyDown}
    />
  )
}
