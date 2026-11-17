import { useEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { CrossIcon } from './icons'

/** A panel over the app. Closes with Escape, the × button or a click outside it. */
export function Modal({ title, onClose, children, actions }: { title: string; onClose(): void; children: ReactNode; actions?: ReactNode }) {
  const panel = useRef<HTMLDivElement>(null)
  const close = useRef(onClose)
  close.current = onClose

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    panel.current?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing) return
      // Handled here, so Escape does not also stop the replies.
      event.preventDefault()
      close.current()
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      previous?.focus()
    }
  }, [])

  return createPortal(
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div ref={panel} className="modal" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1}>
        <div className="modal-head">
          <h2>{title}</h2>
          {actions}
          <button type="button" className="modal-close" aria-label="閉じる" onClick={onClose}>
            <CrossIcon size={16} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>,
    document.body,
  )
}
