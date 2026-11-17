import { useCallback } from 'react'
import { AGENT_IDS, type AgentId } from '../../../shared/types'
import { errorMessage } from '../errors'
import { useChat } from '../useChat'
import { Composer } from './Composer'
import { Header } from './Header'
import { Timeline } from './Timeline'

/** One open conversation. Mounted again (with a fresh state) for each conversation. */
export function ChatView({ conversationId }: { conversationId: string }) {
  const { state, loadError, send, stop } = useChat(conversationId)
  const loadChoices = useCallback((agent: AgentId) => window.agentsync.agentChoices(conversationId, agent), [conversationId])

  if (loadError) {
    return (
      <main className="chat">
        <div className="chat-message">
          <p className="error" role="alert">
            {errorMessage(loadError)}
          </p>
        </div>
      </main>
    )
  }
  if (!state) return <main className="chat" aria-busy="true" />

  const busy = AGENT_IDS.some((id) => state.agents[id].busy)

  return (
    <main className="chat">
      <Header
        title={state.title}
        agents={state.agents}
        onRename={(title) => {
          void window.agentsync.renameConversation(conversationId, title).catch((error: unknown) => console.error(errorMessage(error)))
        }}
        loadChoices={loadChoices}
        onEffort={(agent, effort) => {
          void window.agentsync.setEffort(conversationId, agent, effort).catch((error: unknown) => console.error(errorMessage(error)))
        }}
      />
      <Timeline messages={state.messages} agents={state.agents} />
      <div className="composer-wrap">
        <Composer
          busy={busy}
          onSend={(text, to) => {
            void send({ text, to }).catch((error: unknown) => console.error(errorMessage(error)))
          }}
          onStop={() => void stop()}
        />
      </div>
    </main>
  )
}
