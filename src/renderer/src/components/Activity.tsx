import { useEffect, useState } from 'react'
import type { ActivityKind, AgentActivity } from '../../../shared/types'
import { SearchIcon, TerminalIcon } from './icons'

export const ACTIVITY_LABELS: Record<ActivityKind, string> = {
  thinking: '考え中',
  searching: 'ウェブを検索中',
  working: '作業中',
  waiting: 'あなたの承認待ち',
  writing: '入力中',
}

/** Whole seconds since `since` (ISO 8601), counted up every second. */
function useElapsedSeconds(since: string): number {
  const start = Date.parse(since)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  return Number.isNaN(start) ? 0 : Math.max(0, Math.floor((now - start) / 1000))
}

function ActivityIcon({ kind }: { kind: ActivityKind }) {
  if (kind === 'searching') return <SearchIcon size={14} className="activity-icon" />
  if (kind === 'working') return <TerminalIcon size={14} className="activity-icon" />
  return (
    <span className="dots" aria-hidden="true">
      <span className="dot" />
      <span className="dot" />
      <span className="dot" />
    </span>
  )
}

/**
 * 「考え中… 12 秒」: what a replying agent is doing now, and how long its reply has taken so far.
 * Each reply shows its own line, so two agents working at once are both visible.
 */
export function ActivityLine({ activity, since }: { activity: AgentActivity; since: string }) {
  const seconds = useElapsedSeconds(since)
  return (
    <span className={`activity activity-${activity.kind}`}>
      <ActivityIcon kind={activity.kind} />
      <span className="activity-label">
        {ACTIVITY_LABELS[activity.kind]}…
        {activity.detail && <span className="activity-detail">「{activity.detail}」</span>}
      </span>
      {/* Hidden from screen readers so the timeline does not announce every second. */}
      <span className="activity-time" aria-hidden="true">
        {seconds} 秒
      </span>
    </span>
  )
}
