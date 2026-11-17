import type { ApprovalDecision, ApprovalEntry, ToolLogEntry } from '../../../shared/types'
import { CheckIcon, CrossIcon, FileIcon, FolderIcon, PencilIcon, SearchIcon, TerminalIcon } from './icons'

function StepIcon({ kind }: { kind: ToolLogEntry['kind'] }) {
  if (kind === 'read') return <FileIcon size={13} />
  if (kind === 'search' || kind === 'web') return <SearchIcon size={13} />
  if (kind === 'list') return <FolderIcon size={13} />
  if (kind === 'edit') return <PencilIcon size={13} />
  return <TerminalIcon size={13} />
}

/**
 * What the agent did for this reply (read, searched, edited, ran), in order. Open while the reply is
 * coming in; folded afterwards, and can be opened again.
 */
export function WorkLog({ tools, live }: { tools: ToolLogEntry[]; live: boolean }) {
  const running = tools.filter((t) => t.status === 'running').length
  const failed = tools.filter((t) => t.status === 'failed').length
  return (
    <details className="work-log" open={live}>
      <summary>
        作業ログ（{tools.length} 件{running > 0 ? `・実行中 ${running}` : ''}
        {failed > 0 ? `・失敗 ${failed}` : ''}）
      </summary>
      <ul>
        {tools.map((tool) => (
          <li key={tool.id} className={`work-step work-${tool.status}`}>
            <StepIcon kind={tool.kind} />
            <code title={tool.title}>{tool.title}</code>
            {tool.status === 'running' ? (
              <span className="work-dot" aria-label="実行中" />
            ) : tool.status === 'failed' ? (
              <CrossIcon size={13} className="work-mark" />
            ) : (
              <CheckIcon size={13} className="work-mark" />
            )}
          </li>
        ))}
      </ul>
    </details>
  )
}

/** A diff with its added and removed lines coloured. */
export function DiffText({ text, className }: { text: string; className: string }) {
  return (
    <pre className={className}>
      {text.split('\n').map((line, index) => {
        const kind = line.startsWith('+') && !line.startsWith('+++') ? 'diff-add' : line.startsWith('-') && !line.startsWith('---') ? 'diff-del' : undefined
        return (
          <span key={index} className={kind}>
            {line}
            {'\n'}
          </span>
        )
      })}
    </pre>
  )
}

function Detail({ approval }: { approval: ApprovalEntry }) {
  if (!approval.detail) return null
  if (approval.kind !== 'edit') return <pre className="approval-detail">{approval.detail}</pre>
  return <DiffText text={approval.detail} className="approval-detail" />
}

/** Asks before an edit or a command: 許可 / 今回は全部許可 / 拒否. Once answered, a line saying how. */
export function ApprovalCard({ approval, onAnswer }: { approval: ApprovalEntry; onAnswer(decision: ApprovalDecision): void }) {
  if (approval.status !== 'pending') {
    return (
      <p className={`approval-done approval-${approval.status}`}>
        {approval.status === 'allowed' ? <CheckIcon size={13} /> : <CrossIcon size={13} />}
        {approval.status === 'allowed' ? '許可しました' : '許可しませんでした'}: {approval.title}
      </p>
    )
  }
  return (
    <div className="approval-card" role="group" aria-label="承認の確認">
      <p className="approval-title">{approval.title}</p>
      <Detail approval={approval} />
      <div className="approval-actions">
        <button type="button" className="approval-allow" onClick={() => onAnswer('allow')}>
          許可
        </button>
        <button type="button" onClick={() => onAnswer('allow-all')} title="この返事の間は、あとの確認を出さずに許可します">
          今回は全部許可
        </button>
        <button type="button" className="approval-deny" onClick={() => onAnswer('deny')}>
          拒否
        </button>
      </div>
    </div>
  )
}
