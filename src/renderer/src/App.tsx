import { AGENT_IDS } from '../../shared/types'
import { Composer } from './components/Composer'
import { Header } from './components/Header'
import { Timeline } from './components/Timeline'
import { useChat } from './useChat'

export function App() {
  const { state, send, stop } = useChat()

  if (!state) return <div className="loading">読み込み中…</div>

  const busy = AGENT_IDS.some((id) => state.agents[id].busy)

  return (
    <div className="app">
      <nav className="sidebar" aria-label="会話一覧">
        <div className="brand">AgentSync</div>
        <div className="conversations">
          <div className="conversation conversation-active" aria-current="page">
            {state.title}
          </div>
        </div>
      </nav>
      <main className="chat">
        <Header title={state.title} agents={state.agents} />
        <Timeline messages={state.messages} />
        <div className="composer-wrap">
          <Composer
            busy={busy}
            onSend={(text, to) => {
              void send({ text, to }).catch((error: unknown) => console.error(error))
            }}
            onStop={() => void stop()}
          />
        </div>
      </main>
    </div>
  )
}
