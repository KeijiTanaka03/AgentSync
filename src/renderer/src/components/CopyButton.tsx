import { useEffect, useState } from 'react'
import { CheckIcon, CopyIcon } from './icons'

/** Copies text to the clipboard and says so for a moment. */
export function CopyButton({ getText, label = 'コピー' }: { getText(): string; label?: string }) {
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(timer)
  }, [copied])

  const text = copied ? 'コピーしました' : label
  return (
    <button
      type="button"
      className="copy-button"
      aria-label={text}
      title={text}
      onClick={() => {
        void navigator.clipboard.writeText(getText()).then(
          () => setCopied(true),
          () => {
            // Copying can be refused (e.g. the window is not focused); nothing to undo.
          },
        )
      }}
    >
      {copied ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
      <span className="copy-label">{text}</span>
    </button>
  )
}
