import type { ChatEvent, ChatState } from './types'

/** Applies one event to a chat state. Pure, so the renderer and tests can share it. */
export function applyEvent(state: ChatState, event: ChatEvent): ChatState {
  switch (event.type) {
    case 'message:add':
      if (state.messages.some((m) => m.id === event.message.id)) return state
      return { ...state, messages: [...state.messages, event.message] }
    case 'message:append':
      return {
        ...state,
        messages: state.messages.map((m) => (m.id === event.id ? { ...m, text: m.text + event.text } : m)),
      }
    case 'message:update':
      return {
        ...state,
        messages: state.messages.map((m) => (m.id === event.message.id ? event.message : m)),
      }
    case 'agent:update':
      return { ...state, agents: { ...state.agents, [event.agent.id]: event.agent } }
    case 'agent:activity':
      return { ...state, agents: { ...state.agents, [event.id]: { ...state.agents[event.id], activity: event.activity } } }
    case 'title:update':
      return { ...state, title: event.title }
  }
}
