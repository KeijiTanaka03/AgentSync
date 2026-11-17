import { useCallback, useEffect, useState } from 'react'
import { AGENT_IDS, DISPLAY_NAMES, type AgentId, type UsageReport } from '../../../shared/types'
import { errorMessage } from '../errors'
import { Modal } from './Modal'

const SOURCES: Record<AgentId, string> = { claude: 'Claude Code の /usage ', gpt: 'Codex の使用量' }

/** Each plan's usage limits, as bars. Reading them uses none of them. */
export function UsagePanel({ onClose }: { onClose(): void }) {
  const [usage, setUsage] = useState<Record<AgentId, UsageReport> | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [at, setAt] = useState<Date | null>(null)

  const load = useCallback(() => {
    setUsage(null)
    setError(null)
    window.agentsync.usage().then(
      (result) => {
        setUsage(result)
        setAt(new Date())
      },
      (reason: unknown) => setError(errorMessage(reason)),
    )
  }, [])
  useEffect(load, [load])

  return (
    <Modal
      title="使用量"
      onClose={onClose}
      actions={
        <button type="button" className="modal-action" onClick={load} disabled={!usage && !error}>
          更新
        </button>
      }
    >
      {error && <p className="error">{error}</p>}
      {!usage && !error && <p className="modal-note">読み込み中…（各 CLI に問い合わせています）</p>}
      {usage &&
        AGENT_IDS.map((id) => (
          <section key={id} className="usage-section">
            <h3>
              <span className={`avatar avatar-${id} avatar-sm`} aria-hidden="true">
                {id === 'claude' ? 'C' : 'G'}
              </span>
              {DISPLAY_NAMES[id]}
            </h3>
            {usage[id].error && <p className="error">{usage[id].error}</p>}
            {usage[id].windows.map((window) => (
              <div key={window.label} className="usage-row">
                <div className="usage-label">
                  <span>{window.label}</span>
                  <b>{Math.round(window.usedPercent)}%</b>
                </div>
                <div className="usage-bar" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={window.usedPercent} aria-label={window.label}>
                  <span
                    className={window.usedPercent >= 90 ? 'usage-fill usage-high' : window.usedPercent >= 70 ? 'usage-fill usage-mid' : 'usage-fill'}
                    style={{ width: `${Math.min(100, window.usedPercent)}%` }}
                  />
                </div>
                {window.resets && <p className="usage-reset">リセット: {window.resets}</p>}
              </div>
            ))}
            <p className="modal-note">{SOURCES[id]}から読んでいます（使用枠は使いません）。</p>
          </section>
        ))}
      {at && <p className="modal-note">{at.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })} 時点</p>}
    </Modal>
  )
}
