import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { AgentSyncApi, ChatEventEnvelope, ChatSnapshot, SendRequest } from '../shared/types'

// The only bridge between the page and the main process. Keep it small.
const api: AgentSyncApi = {
  snapshot: () => ipcRenderer.invoke('chat:snapshot') as Promise<ChatSnapshot>,
  send: (request: SendRequest) => ipcRenderer.invoke('chat:send', request) as Promise<void>,
  stop: () => ipcRenderer.invoke('chat:stop') as Promise<void>,
  onEvent: (listener) => {
    const handler = (_event: IpcRendererEvent, envelope: ChatEventEnvelope) => listener(envelope)
    ipcRenderer.on('chat:event', handler)
    return () => {
      ipcRenderer.removeListener('chat:event', handler)
    }
  },
}

contextBridge.exposeInMainWorld('agentsync', api)
