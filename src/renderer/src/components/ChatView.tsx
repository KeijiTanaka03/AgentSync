import { useCallback, useEffect, useRef } from 'react'
import { AGENT_IDS, DISPLAY_NAMES, otherAgent, type AgentId, type AgentInfo, type ChatState, type DialogueState } from '../../../shared/types'
import { errorMessage } from '../errors'
import { useChat } from '../useChat'
import { Composer } from './Composer'
import { Header } from './Header'
import { LoopIcon } from './icons'
import { Timeline } from './Timeline'

/** One open conversation. Mounted again (with a fresh state) for each conversation. */
export function ChatView({ conversationId }: { conversationId: string }) {
  const { state, loadError, send, stop } = useChat(conversationId)
  const loadChoices = useCallback((agent: AgentId) => window.agentsync.agentChoices(conversationId, agent), [conversationId])

  const toggleDialogue = (current: ChatState) => {
    if (current.dialogue === null && !canStartDialogue(current)) return
    void window.agentsync.setDialogue(conversationId, current.dialogue === null).catch((error: unknown) => console.error(errorMessage(error)))
  }

  // Menu shortcuts (⇧⌘D, ⌘.) act on the conversation that is open.
  const latest = useRef({ state, toggleDialogue, stop })
  latest.current = { state, toggleDialogue, stop }
  useEffect(
    () =>
      window.agentsync.onMenuCommand((command) => {
        const { state: current, toggleDialogue: toggle, stop: stopReplies } = latest.current
        if (command === 'stop') void stopReplies()
        else if (command === 'toggle-dialogue' && current) toggle(current)
      }),
    [],
  )

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
        onModel={(agent, model) => {
          void window.agentsync.setModel(conversationId, agent, model).catch((error: unknown) => console.error(errorMessage(error)))
        }}
        onEffort={(agent, effort) => {
          void window.agentsync.setEffort(conversationId, agent, effort).catch((error: unknown) => console.error(errorMessage(error)))
        }}
      />
      <Timeline messages={state.messages} agents={state.agents} />
      <div className="composer-wrap">
        {state.dialogue && <DialogueBar dialogue={state.dialogue} agents={state.agents} />}
        <Composer
          busy={busy}
          dialogue={state.dialogue !== null}
          canStartDialogue={canStartDialogue(state)}
          onToggleDialogue={() => toggleDialogue(state)}
          onSend={(text, to) => {
            void send({ text, to }).catch((error: unknown) => console.error(errorMessage(error)))
          }}
          onStop={() => void stop()}
        />
      </div>
    </main>
  )
}

/** Dialogue mode needs something to talk about. */
function canStartDialogue(state: ChatState): boolean {
  return state.messages.some((m) => m.from !== 'system')
}

/** 「対話モード中 · 3 発言 · 次: GPT」 above the input while the agents take turns. */
function DialogueBar({ dialogue, agents }: { dialogue: DialogueState; agents: Record<AgentId, AgentInfo> }) {
  // `next` is the one speaking now once its reply has started; then the other one is next.
  const after = agents[dialogue.next].busy ? otherAgent(dialogue.next) : dialogue.next
  return (
    <div className="dialogue-bar" role="status">
      <LoopIcon size={15} className="dialogue-bar-icon" />
      <b>対話モード中</b>
      <span>{dialogue.turns} 発言 · 止めるまで続きます</span>
      <span className="dialogue-next">次: {DISPLAY_NAMES[after]}</span>
      <span className="dialogue-hint">もう一度「対話モード」を押すと止まります</span>
    </div>
  )
}
