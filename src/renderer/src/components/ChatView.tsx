import { useCallback, useEffect, useRef } from 'react'
import {
  AGENT_IDS,
  DISPLAY_NAMES,
  otherAgent,
  type AgentId,
  type AgentInfo,
  type ApprovalMode,
  type ChatState,
  type DialogueState,
  type ReviewState,
 
  type Roles,
} from '../../../shared/types'
import { errorMessage } from '../errors'
import { useChat } from '../useChat'
import { Composer } from './Composer'
import { Header } from './Header'
import { CodeIcon, LoopIcon } from './icons'
import { Timeline } from './Timeline'

/** One open conversation. Mounted again (with a fresh state) for each conversation. */
export function ChatView({ conversationId, active = true, independentScroll = false, initialScrollTop }: { conversationId: string; active?: boolean; independentScroll?: boolean; initialScrollTop?: number }) {
  const { state, loadError, send, stop } = useChat(conversationId)
  const loadChoices = useCallback((agent: AgentId) => window.agentsync.agentChoices(conversationId, agent), [conversationId])

  const toggleDialogue = (current: ChatState) => {
    if (current.dialogue === null && (!canStartDialogue(current) || current.review !== null)) return
    void window.agentsync.setDialogue(conversationId, current.dialogue === null).catch((error: unknown) => console.error(errorMessage(error)))
  }

  // Menu shortcuts (⇧⌘D, ⌘.) act only on the selected pane.
  const latest = useRef({ state, toggleDialogue, stop, active })
  latest.current = { state, toggleDialogue, stop, active }
  // Esc stops the replies, as in Claude Code — unless it is closing something else or ending an IME conversion.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!latest.current.active) return
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing || event.keyCode === 229) return
      const current = latest.current.state
      if (!current) return
      const running = current.dialogue !== null || current.review !== null || AGENT_IDS.some((id) => current.agents[id].busy)
      if (running) void latest.current.stop()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(
    () =>
      window.agentsync.onMenuCommand((command) => {
        if (!latest.current.active) return
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
        workspace={state.workspace}
        approvalMode={state.approvalMode}
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
      <Timeline
        messages={state.messages}
        followOwnMessages={!independentScroll}
        initialScrollTop={initialScrollTop}
        agents={state.agents}
        kind={state.kind}
        onApprove={(approvalId, decision) => {
          void window.agentsync.approve(conversationId, approvalId, decision).catch((error: unknown) => console.error(errorMessage(error)))
        }}
      />
      <div className="composer-wrap">
        {state.dialogue && <DialogueBar dialogue={state.dialogue} agents={state.agents} />}
        {state.review && <ReviewBar review={state.review} />}
        <Composer
          busy={busy}
          dialogue={state.dialogue !== null}
          canStartDialogue={canStartDialogue(state)}
          onToggleDialogue={() => toggleDialogue(state)}
          {...(state.kind === 'code'
            ? {
                reviewing: state.review !== null,
                onStopReview: () => {
                  void window.agentsync.setReview(conversationId, null).catch((error: unknown) => console.error(errorMessage(error)))
                },
                approvalMode: state.approvalMode,
                roles: state.roles,
                onRoles: (roles: Roles) => {
                  void window.agentsync.setRoles(conversationId, roles).catch((error: unknown) => console.error(errorMessage(error)))
                },
                onApprovalMode: (mode: ApprovalMode) => {
                  void window.agentsync.setApprovalMode(conversationId, mode).catch((error: unknown) => console.error(errorMessage(error)))
                },
              }
            : {})}
          history={state.messages.filter((m) => m.from === 'user').map((m) => m.text)}
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

/** 「実装＋レビュー中 · 1/3 往復 · いま: Claude が実装」 above the input. */
function ReviewBar({ review }: { review: ReviewState }) {
  const now = review.phase === 'implement' ? `${DISPLAY_NAMES[review.implementer]} が実装` : `${DISPLAY_NAMES[review.reviewer]} がレビュー`
  return (
    <div className="dialogue-bar" role="status">
      <CodeIcon size={15} className="dialogue-bar-icon" />
      <b>実装＋レビュー中</b>
      <span>
        {review.round}/{review.maxRounds} 往復 · APPROVED か上限で止まります
      </span>
      <span className="dialogue-next">いま: {now}</span>
      <span className="dialogue-hint">もう一度「実装＋レビュー」を押すと止まります</span>
    </div>
  )
}
