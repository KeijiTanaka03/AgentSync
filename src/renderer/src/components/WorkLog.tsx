import { useState } from 'react'
import type { ApprovalDecision, ApprovalEntry, QuestionAnswers, ToolLogEntry } from '../../../shared/types'
import { TokenUsageLine } from './TokenUsageLine'
import { ChatIcon, CheckIcon, CrossIcon, FileIcon, FolderIcon, PencilIcon, SearchIcon, TerminalIcon } from './icons'

function StepIcon({ kind }: { kind: ToolLogEntry['kind'] }) {
  if (kind === 'read') return <FileIcon size={13} />
  if (kind === 'search' || kind === 'web') return <SearchIcon size={13} />
  if (kind === 'list') return <FolderIcon size={13} />
  if (kind === 'edit') return <PencilIcon size={13} />
  if (kind === 'note') return <ChatIcon size={13} />
  return <TerminalIcon size={13} />
}

/** What the agent did for this reply, with disclosure controlled by the reader. */
export function WorkLog({ tools }: { tools: ToolLogEntry[] }) {
  const running = tools.filter((t) => t.status === 'running').length
  const failed = tools.filter((t) => t.status === 'failed').length
  return (
    <details className="work-log">
      <summary>
        作業ログ（{tools.length} 件{running > 0 ? `・実行中 ${running}` : ''}
        {failed > 0 ? `・失敗 ${failed}` : ''}）
      </summary>
      <ul>
        {tools.map((tool) => (
          <li key={tool.id} className={`work-step work-${tool.status}${tool.kind === 'note' ? ' work-note' : ''}`}>
            <StepIcon kind={tool.kind} />
            <div className="work-step-main">
              {tool.kind === 'note' ? <span className="work-note-text">{tool.title}</span> : <code title={tool.title}>{tool.title}</code>}
              {tool.tokenUsage && <TokenUsageLine usage={tool.tokenUsage} />}
            </div>
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

/**
 * A question the agent asked (Claude Code's AskUserQuestion, Codex's request_user_input): pick an option or
 * type an answer, then 回答する. Asked even in auto, as in Claude Code and Codex.
 */
export function QuestionCard({ approval, onAnswer }: { approval: ApprovalEntry; onAnswer(answers: QuestionAnswers | null): void }) {
  const questions = approval.questions ?? []
  const [chosen, setChosen] = useState<Record<string, string[]>>({})
  const [typed, setTyped] = useState<Record<string, string>>({})
  if (approval.status !== 'pending') {
    return (
      <div className={`approval-done approval-${approval.status}`}>
        {approval.status === 'allowed' ? <CheckIcon size={13} /> : <CrossIcon size={13} />}
        {approval.status === 'allowed' ? (
          <span>
            回答しました:{' '}
            {questions.map((q) => (q.secret ? '（非表示）' : (approval.answers?.[q.id] ?? []).join(', '))).filter(Boolean).join(' / ')}
          </span>
        ) : (
          <span>回答しませんでした: {approval.title}</span>
        )}
      </div>
    )
  }
  const answers = (): QuestionAnswers =>
    Object.fromEntries(
      questions.map((q) => {
        const own = typed[q.id]?.trim()
        return [q.id, [...(chosen[q.id] ?? []), ...(own ? [own] : [])]]
      }),
    )
  const complete = questions.every((q) => (answers()[q.id] ?? []).length > 0)
  const pick = (id: string, label: string, multi: boolean) =>
    setChosen((current) => {
      const now = current[id] ?? []
      return { ...current, [id]: multi ? (now.includes(label) ? now.filter((l) => l !== label) : [...now, label]) : now.includes(label) ? [] : [label] }
    })
  return (
    <div className="approval-card question-card" role="group" aria-label={approval.title}>
      <p className="approval-title">{approval.title}</p>
      {questions.map((q) => (
        <fieldset key={q.id} className="question">
          <legend>
            {q.header && <span className="question-header">{q.header}</span>}
            {q.question}
          </legend>
          {q.options.length > 0 && (
            <div className="question-options">
              {q.options.map((option) => (
                <button
                  key={option.label}
                  type="button"
                  className="question-option"
                  aria-pressed={(chosen[q.id] ?? []).includes(option.label)}
                  title={option.description ?? undefined}
                  onClick={() => pick(q.id, option.label, q.multiSelect)}
                >
                  <span>{option.label}</span>
                  {option.description && <small>{option.description}</small>}
                </button>
              ))}
            </div>
          )}
          {(q.allowOther || q.options.length === 0) && (
            <input
              type={q.secret ? 'password' : 'text'}
              autoComplete="off"
              className="question-other"
              placeholder={q.secret ? '入力内容は表示・保存されません' : q.options.length ? 'その他（自分で入力）' : '回答を入力'}
              value={typed[q.id] ?? ''}
              onChange={(event) => setTyped((current) => ({ ...current, [q.id]: event.target.value }))}
            />
          )}
        </fieldset>
      ))}
      <div className="approval-actions">
        <button type="button" className="approval-allow" disabled={!complete} onClick={() => onAnswer(answers())}>
          回答する
        </button>
        <button type="button" onClick={() => onAnswer(null)}>
          答えない
        </button>
      </div>
    </div>
  )
}
