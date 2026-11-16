import type { AgentId } from '../../../shared/types'

const LETTERS: Record<AgentId, string> = { claude: 'C', gpt: 'G' }

export function Avatar({ agent, size = 'md' }: { agent: AgentId; size?: 'sm' | 'md' }) {
  return (
    <span className={`avatar avatar-${agent} avatar-${size}`} aria-hidden="true">
      {LETTERS[agent]}
    </span>
  )
}
