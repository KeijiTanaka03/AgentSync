import { useEffect, useState } from 'react'
import { AGENT_IDS, DISPLAY_NAMES, type AgentId, type UsageReport } from '../../../shared/types'
import { errorMessage } from '../errors'

type Usage = Record<AgentId, UsageReport>
// Share an in-flight read across StrictMode's mount cycle.
let pending: Promise<Usage> | null = null
function readUsage(): Promise<Usage> {
  if (!pending) pending = window.agentsync.usage().finally(() => { pending = null })
  return pending
}

/** Compact plan usage, fixed at the bottom of the conversation sidebar. */
export function UsageSummary({ onDetails }: { onDetails(): void }) {
  const [usage, setUsage] = useState<Usage | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null)
  useEffect(() => {
    let active = true
    let reading = false
    let lastRead = 0
    const refresh = () => {
      if (document.hidden || reading || Date.now() - lastRead < 10_000) return
      reading = true
      lastRead = Date.now()
      void readUsage().then(
        (result) => {
          if (!active) return
          setUsage(result)
          setError(null)
          setUpdatedAt(new Date())
        },
        (reason: unknown) => { if (active) setError(errorMessage(reason)) },
      ).finally(() => { reading = false })
    }
    refresh()
    const timer = window.setInterval(refresh, 60_000)
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      active = false
      window.clearInterval(timer)
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [])

  return (
    <section className="usage-summary" aria-label="プランの使用量">
      <div className="usage-summary-heading">
        <button type="button" onClick={onDetails} title="使用量の詳細と更新">使用量</button>
        <span title={error ?? undefined}>
          {error ? '更新できません' : updatedAt ? `${updatedAt.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })} 時点` : '読み込み中…'}
        </span>
      </div>
      {AGENT_IDS.map((id) => <UsageSummaryAgent key={id} id={id} report={usage?.[id] ?? null} stale={error !== null} />)}
    </section>
  )
}

export function UsageSummaryAgent({ id, report, stale = false }: { id: AgentId; report: UsageReport | null; stale?: boolean }) {
  return (
    <div className={`usage-summary-agent usage-summary-${id}`}>
      <b>{DISPLAY_NAMES[id]}</b>
      {report?.windows.length ? report.windows.map((item) => {
        const percent = Math.max(0, Math.min(100, Number.isFinite(item.usedPercent) ? item.usedPercent : 0))
        return (
          <div className="usage-summary-window" key={item.label} title={report.error ?? (item.resets ? `リセット: ${item.resets}` : undefined)}>
            <span className="usage-summary-label">{item.label}</span>
            <div className="usage-bar" role="meter" aria-label={`${DISPLAY_NAMES[id]} ${item.label}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
              <span className={`usage-fill${percent >= 90 ? ' usage-high' : percent >= 70 ? ' usage-mid' : ''}`} style={{ width: `${percent}%` }} />
            </div>
            <span className="usage-summary-percent">{Math.round(percent)}%{stale || report.error ? ' *' : ''}</span>
          </div>
        )
      }) : <span className="usage-summary-unavailable" title={report?.error ?? undefined}>{report ? report.error ? '取得できません' : 'データなし' : '—'}</span>}
    </div>
  )
}
