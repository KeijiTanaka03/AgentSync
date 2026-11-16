import type { AgentSyncApi } from '../../shared/types'

declare global {
  interface Window {
    agentsync: AgentSyncApi
  }
}

export {}
