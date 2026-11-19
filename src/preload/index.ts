import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type {
  CliId,
  ConnectionList,
  UsageReport,
  AgentChoices,
  AgentId,
  ApprovalDecision,
  ApprovalMode,
  QuestionAnswers,
  AgentSyncApi,
  ChatSnapshot,
  ConversationEventEnvelope,
  ConversationSummary,
  MenuCommand,
  SendRequest,
  Roles,
} from '../shared/types'

function subscribe<T>(channel: string, listener: (payload: T) => void): () => void {
  const handler = (_event: IpcRendererEvent, payload: T) => listener(payload)
  ipcRenderer.on(channel, handler)
  return () => {
    ipcRenderer.removeListener(channel, handler)
  }
}

// The only bridge between the page and the main process. Keep it small.
const api: AgentSyncApi = {
  listConversations: () => ipcRenderer.invoke('conversations:list') as Promise<ConversationSummary[]>,
  createConversation: () => ipcRenderer.invoke('conversations:create') as Promise<string>,
  createCodeConversation: () => ipcRenderer.invoke('conversations:create-code') as Promise<string | null>,
  renameConversation: (id: string, title: string) => ipcRenderer.invoke('conversations:rename', id, title) as Promise<void>,
  pinConversation: (id: string, pinned: boolean) => ipcRenderer.invoke('conversations:pin', id, pinned) as Promise<void>,
  deleteConversation: (id: string) => ipcRenderer.invoke('conversations:delete', id) as Promise<boolean>,
  snapshot: (id: string) => ipcRenderer.invoke('chat:snapshot', id) as Promise<ChatSnapshot>,
  agentChoices: (id: string, agent: AgentId) => ipcRenderer.invoke('agents:choices', id, agent) as Promise<AgentChoices>,
  setEffort: (id: string, agent: AgentId, effort: string | null) => ipcRenderer.invoke('agents:effort', id, agent, effort) as Promise<void>,
  setModel: (id: string, agent: AgentId, model: string | null) => ipcRenderer.invoke('agents:model', id, agent, model) as Promise<void>,
  send: (id: string, request: SendRequest, files) => ipcRenderer.invoke('chat:send', id, request, files) as Promise<void>,
  pasteFiles: () => ipcRenderer.invoke('attachments:paste'),
  revealAttachment: (id, attachment) => ipcRenderer.invoke('attachments:reveal', id, attachment),
  stop: (id: string) => ipcRenderer.invoke('chat:stop', id) as Promise<void>,
  setDialogue: (id: string, on: boolean) => ipcRenderer.invoke('chat:dialogue', id, on) as Promise<void>,
  setReview: (id: string, implementer: AgentId | null, task?: string) =>
    ipcRenderer.invoke('chat:review', id, implementer, task ?? '') as Promise<void>,
  approve: (id: string, approvalId: string, decision: ApprovalDecision) =>
    ipcRenderer.invoke('chat:approve', id, approvalId, decision) as Promise<void>,
  answer: (id: string, approvalId: string, answers: QuestionAnswers | null) =>
    ipcRenderer.invoke('chat:answer', id, approvalId, answers) as Promise<void>,
  setApprovalMode: (id: string, mode: ApprovalMode) => ipcRenderer.invoke('chat:approval-mode', id, mode) as Promise<void>,
  setRoles: (id: string, roles: Roles) => ipcRenderer.invoke('chat:roles', id, roles) as Promise<void>,
  openLocalLink: (href) => ipcRenderer.invoke('links:open-local', href),
  usage: () => ipcRenderer.invoke('usage:read') as Promise<Record<AgentId, UsageReport>>,
  listConnections: () => ipcRenderer.invoke('connections:list') as Promise<Record<CliId, ConnectionList>>,
  addConnection: (cli: CliId, name: string, url: string) => ipcRenderer.invoke('connections:add', cli, name, url) as Promise<void>,
  removeConnection: (cli: CliId, name: string) => ipcRenderer.invoke('connections:remove', cli, name) as Promise<boolean>,
  loginConnection: (cli: CliId, name: string) => ipcRenderer.invoke('connections:login', cli, name) as Promise<string>,
  onEvent: (listener) => subscribe<ConversationEventEnvelope>('chat:event', listener),
  onConversations: (listener) => subscribe<ConversationSummary[]>('conversations:changed', listener),
  onMenuCommand: (listener) => subscribe<MenuCommand>('menu:command', listener),
}

contextBridge.exposeInMainWorld('agentsync', api)
