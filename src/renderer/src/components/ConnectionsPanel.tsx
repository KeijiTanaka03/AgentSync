import { useCallback, useEffect, useState, type FormEvent } from 'react'
import type { CliId, Connection, ConnectionList } from '../../../shared/types'
import { errorMessage } from '../errors'
import { Modal } from './Modal'

const CLIS: { id: CliId; name: string; agent: string }[] = [
  { id: 'claude', name: 'Claude Code', agent: 'Claude' },
  { id: 'codex', name: 'Codex', agent: 'GPT' },
]

const STATUS: Record<Connection['status'], string> = {
  connected: 'つながっています',
  'needs-auth': 'ログインが必要',
  failed: 'つながりません',
  disabled: '無効',
  unknown: '不明',
}

/** The connectors (MCP servers) of each CLI: what is there, and adding, removing and signing in. */
export function ConnectionsPanel({ onClose }: { onClose(): void }) {
  const [lists, setLists] = useState<Record<CliId, ConnectionList> | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(() => {
    setLists(null)
    window.agentsync.listConnections().then(setLists, (reason: unknown) => setMessage(errorMessage(reason)))
  }, [])
  useEffect(load, [load])

  const act = async (work: () => Promise<unknown>, after?: (result: unknown) => void) => {
    setBusy(true)
    setMessage(null)
    try {
      const result = await work()
      after?.(result)
      load()
    } catch (reason) {
      setMessage(errorMessage(reason))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title="連携の管理"
      onClose={onClose}
      actions={
        <button type="button" className="modal-action" onClick={load} disabled={busy || !lists}>
          更新
        </button>
      }
    >
      <p className="modal-note">
        Claude と GPT は、それぞれの CLI につないだ連携（MCP サーバー）を、普段どおり使えます。読み取りはそのまま進み、作成・変更・削除は承認カードで確認します。
      </p>
      {message && <p className="connections-message">{message}</p>}
      {!lists && <p className="modal-note">読み込み中…</p>}
      {lists &&
        CLIS.map((cli) => (
          <section key={cli.id} className="connections-section">
            <h3>
              {cli.agent} <span className="connections-cli">（{cli.name}）</span>
            </h3>
            {lists[cli.id].error && <p className="error">{lists[cli.id].error}</p>}
            {lists[cli.id].connections.length === 0 && !lists[cli.id].error && <p className="modal-note">まだありません。</p>}
            <ul className="connections-list">
              {lists[cli.id].connections.map((connection) => (
                <li key={connection.name} className="connection-row">
                  <div className="connection-main">
                    <b>{connection.name}</b>
                    <span className="connection-target" title={connection.target}>
                      {connection.target}
                    </span>
                  </div>
                  <span className={`connection-status status-${connection.status}`}>{STATUS[connection.status]}</span>
                  <div className="connection-actions">
                    {connection.managedAtClaudeAi ? (
                      <a href="https://claude.ai/settings/connectors" target="_blank" rel="noreferrer">
                        claude.ai で管理
                      </a>
                    ) : (
                      <>
                        {(connection.status === 'needs-auth' || cli.id === 'codex') && (
                          <button type="button" disabled={busy} onClick={() => void act(() => window.agentsync.loginConnection(cli.id, connection.name), (text) => setMessage(String(text)))}>
                            ログイン
                          </button>
                        )}
                        <button type="button" className="danger" disabled={busy} onClick={() => void act(() => window.agentsync.removeConnection(cli.id, connection.name))}>
                          削除…
                        </button>
                      </>
                    )}
                  </div>
                </li>
              ))}
            </ul>
            <AddConnection busy={busy} onAdd={(name, url) => act(() => window.agentsync.addConnection(cli.id, name, url))} />
          </section>
        ))}
      <p className="modal-note">
        追加と削除は各 CLI の設定（Claude Code はユーザー全体、Codex は ~/.codex/config.toml）を書き換えます。ターミナルで CLI を使うときにも反映されます。
      </p>
    </Modal>
  )
}

function AddConnection({ busy, onAdd }: { busy: boolean; onAdd(name: string, url: string): Promise<void> }) {
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!name.trim() || !url.trim()) return
    void onAdd(name.trim(), url.trim()).then(() => {
      setName('')
      setUrl('')
    })
  }
  return (
    <form className="connection-add" onSubmit={submit}>
      <input aria-label="名前" placeholder="名前（例: linear）" value={name} onChange={(event) => setName(event.target.value)} spellCheck={false} />
      <input aria-label="URL" placeholder="URL（例: https://mcp.linear.app/mcp）" value={url} onChange={(event) => setUrl(event.target.value)} spellCheck={false} />
      <button type="submit" disabled={busy || !name.trim() || !url.trim()}>
        追加
      </button>
    </form>
  )
}
