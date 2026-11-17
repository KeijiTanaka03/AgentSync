import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

interface PopupMenuProps {
  /** Window coordinates the menu hangs from (usually just below the button that opened it). */
  x: number
  y: number
  /** `end` puts the menu's right edge at `x`, for buttons near the right side of the window. */
  align?: 'start' | 'end'
  label: string
  className?: string
  /** `restoreFocus` is true when the menu was closed with the keyboard. */
  onClose(restoreFocus: boolean): void
  children: ReactNode
}

const ITEMS = '[role="menuitem"], [role="menuitemradio"]'

/**
 * A small pop-up menu drawn above everything else. It stays inside the window, closes on a click
 * elsewhere, Escape, scrolling or the window losing focus, and can be used with the arrow keys.
 */
export function PopupMenu({ x, y, align = 'start', label, className, onClose, children }: PopupMenuProps) {
  const ref = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)
  const close = useRef(onClose)
  close.current = onClose

  // Keep the menu inside the window (it opens upwards near the bottom). Runs again when its items change.
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    const { width, height } = element.getBoundingClientRect()
    const margin = 8
    const left = Math.max(margin, Math.min(align === 'end' ? x - width : x, window.innerWidth - width - margin))
    // Below the button; above it when there is no room; otherwise as high as needed (a tall menu scrolls).
    const above = y - height - 8
    const top = y + height + margin <= window.innerHeight ? y : above >= margin ? above : Math.max(margin, window.innerHeight - height - margin)
    if (position?.left !== left || position?.top !== top) setPosition({ left, top })
  })

  // Focus the chosen item (or the first one) as soon as there is one; until then, the menu itself.
  useEffect(() => {
    const element = ref.current
    if (!element) return
    const active = document.activeElement
    if (active !== element && element.contains(active)) return
    const item = element.querySelector<HTMLElement>('[aria-checked="true"]') ?? element.querySelector<HTMLElement>(ITEMS)
    ;(item ?? element).focus()
  })

  useEffect(() => {
    const onPointerDown = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) close.current(false)
    }
    const dismiss = () => close.current(false)
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('scroll', dismiss, true)
    window.addEventListener('blur', dismiss)
    window.addEventListener('resize', dismiss)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('scroll', dismiss, true)
      window.removeEventListener('blur', dismiss)
      window.removeEventListener('resize', dismiss)
    }
  }, [])

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape' || event.key === 'Tab') {
      event.preventDefault()
      onClose(true)
      return
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    event.preventDefault()
    const items = [...(ref.current?.querySelectorAll<HTMLElement>(ITEMS) ?? [])]
    if (items.length === 0) return
    const index = items.indexOf(document.activeElement as HTMLElement)
    const step = event.key === 'ArrowDown' ? 1 : -1
    const next = index === -1 ? (step === 1 ? 0 : items.length - 1) : (index + step + items.length) % items.length
    items[next]!.focus()
  }

  return createPortal(
    <div
      ref={ref}
      className={className ? `menu ${className}` : 'menu'}
      role="menu"
      aria-label={label}
      tabIndex={-1}
      style={position ?? { left: x, top: y, visibility: 'hidden' }}
      onKeyDown={onKeyDown}
    >
      {children}
    </div>,
    document.body,
  )
}
