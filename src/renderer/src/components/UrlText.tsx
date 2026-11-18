import type { ComponentProps } from 'react'
import { isLocalLink } from '../../../shared/localLinks'

/** Mouse links open on double-click; keyboard activation keeps the standard link behavior. */
export function ExternalLink({ href, children, ...props }: ComponentProps<'a'>) {
  const local = href && isLocalLink(href)
  const reveal = () => { if (href) void window.agentsync.revealLocalLink(href).catch(console.error) }
  return (
    <a {...props} href={href} target="_blank" rel="noreferrer"
      onClick={(event) => {
        if (event.detail !== 0 || local) event.preventDefault()
        if (event.detail === 0 && local) reveal()
      }}
      onDoubleClick={(event) => {
        event.preventDefault()
        if (local) {
          reveal()
          return
        }
        if (!href) return
        try {
          const url = new URL(href)
          if (url.protocol === 'https:' || url.protocol === 'http:') window.open(url.href, '_blank', 'noopener,noreferrer')
        } catch { /* Non-web destinations are not opened. */ }
      }}
      title={props.title ?? 'ダブルクリックでリンクを開く'}
    >{children}</a>
  )
}

/** Linkify URLs without interpreting the user's message or code as Markdown. */
export function UrlText({ text }: { text: string }) {
  const parts = text.split(/(https?:\/\/[^\s<>"`「」『』【】、。]+)/g)
  return <>{parts.map((part, index) => {
    if (!/^https?:\/\//.test(part)) return part
    const url = part.replace(/[.,!?;:]+$/, '')
    return <span key={index}><ExternalLink href={url}>{url}</ExternalLink>{part.slice(url.length)}</span>
  })}</>
}
