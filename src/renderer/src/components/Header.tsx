import { AGENT_IDS, DISPLAY_NAMES, type AgentId, type AgentInfo } from '../../../shared/types'
import { Avatar } from './Avatar'

export function Header({ title, agents }: { title: string; agents: Record<AgentId, AgentInfo> }) {
  return (
    <header className="header">
      <h1>{title}</h1>
      <div className="participants">
        {AGENT_IDS.map((id) => {
          const agent = agents[id]
          return (
            <div key={id} className="participant">
              <Avatar agent={id} size="sm" />
              <span className="participant-name">{DISPLAY_NAMES[id]}</span>
              {agent.model && <span className="participant-model">{agent.model}</span>}
              {agent.busy && <span className="participant-busy">入力中…</span>}
            </div>
          )
        })}
      </div>
    </header>
  )
}
