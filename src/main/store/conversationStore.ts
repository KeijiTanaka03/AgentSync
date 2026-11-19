import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  AGENT_IDS,
  DEFAULT_TITLE,
  type AgentId,
  type ApprovalEntry,
  type ApprovalMode,
  type ChatMessage,
  type ConversationKind,
  type FileAttachment,
  type MessageStatus,
  type NoticeKind,
  type Recipient,
  type Sender,
  type ToolLogEntry,
  type Roles,
} from '../../shared/types'
import { isConversationId, isEffort } from '../../shared/validate'
import { AttachmentStore, parseFileAttachment } from './attachmentStore'

/** What the app remembers about one agent in one conversation. */
export interface StoredParticipant {
  /** Model to use (null: the CLI's default). */
  model: string | null
  /** Reasoning effort to use (null: the CLI's own setting). */
  effort: string | null
  /** CLI session (Claude) or thread (Codex). */
  sessionId: string | null
  /** IDs of messages already handed to this agent's CLI session. */
  delivered: number[]
}

/** The part of a conversation the orchestrator owns. */
export interface ConversationContent {
  title: string
  messages: ChatMessage[]
  participants: Record<AgentId, StoredParticipant>
  /** Coding conversations: how edits and commands are allowed. */
  approvalMode: ApprovalMode
  /** Coding conversations: no roles, both agents may change the project. */
  roles: Roles
}

/** One conversation file: `conversations/<id>.json`. */
export interface ConversationData extends ConversationContent {
  version: 1
  id: string
  kind: ConversationKind
  /** The project folder of a coding conversation (absolute); null for a chat. */
  workdir: string | null
  /** Kept at the top of the list. Older files have no such field. */
  pinned?: boolean
  createdAt: string
  updatedAt: string
}

const FORMAT_VERSION = 1
const FILE_NAME = /^([a-z0-9][a-z0-9-]{0,63})\.json$/
const SENDERS: readonly Sender[] = ['user', 'system', ...AGENT_IDS]
const RECIPIENTS: readonly Recipient[] = ['all', 'user', ...AGENT_IDS]
const NOTICES: readonly NoticeKind[] = ['dialogue-start', 'dialogue-stop', 'review-start', 'review-diff', 'review-stop']
const STATUSES: readonly MessageStatus[] = ['streaming', 'done', 'stopped', 'error']

const isString = (value: unknown): value is string => typeof value === 'string'
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

const TOOL_KINDS: readonly ToolLogEntry['kind'][] = ['read', 'search', 'list', 'edit', 'command', 'web', 'other']
const APPROVAL_KINDS: readonly ApprovalEntry['kind'][] = ['command', 'edit', 'other']

function parseTool(raw: unknown): ToolLogEntry | null {
  if (!isRecord(raw) || !isString(raw.id) || !isString(raw.title) || !TOOL_KINDS.includes(raw.kind as ToolLogEntry['kind'])) return null
  // A step still running when the app closed did not finish.
  const status = raw.status === 'done' ? 'done' : 'failed'
  return {
    id: raw.id,
    kind: raw.kind as ToolLogEntry['kind'],
    title: raw.title,
    status,
  }
}

function parseApproval(raw: unknown): ApprovalEntry | null {
  if (!isRecord(raw) || !isString(raw.id) || !isString(raw.title) || !APPROVAL_KINDS.includes(raw.kind as ApprovalEntry['kind'])) return null
  // A card still waiting when the app closed was never allowed.
  const status = raw.status === 'allowed' ? 'allowed' : 'denied'
  return {
    id: raw.id,
    kind: raw.kind as ApprovalEntry['kind'],
    title: raw.title,
    detail: isString(raw.detail) ? raw.detail : null,
    status,
  }
}

function parseMessage(raw: unknown): ChatMessage | null {
  if (!isRecord(raw)) return null
  const { id, from, to, text, at, status, error, notice, tools, approvals, implementer, detail, attachments } = raw
  if (!Number.isSafeInteger(id) || (id as number) < 1) return null
  if (!SENDERS.includes(from as Sender) || !RECIPIENTS.includes(to as Recipient)) return null
  if (!isString(text) || !isString(at) || !STATUSES.includes(status as MessageStatus)) return null
  const message: ChatMessage = {
    id: id as number,
    from: from as Sender,
    to: to as Recipient,
    text,
    at,
    // A reply that was still streaming when the app closed did not finish.
    status: status === 'streaming' ? 'stopped' : (status as MessageStatus),
  }
  if (isString(error)) message.error = error
  if (from === 'user' && Array.isArray(attachments)) {
    const files = attachments.map(parseFileAttachment).filter((file): file is FileAttachment => file !== null)
    if (files.length) message.attachments = files
  }
  if (Array.isArray(tools)) message.tools = tools.map(parseTool).filter((t): t is ToolLogEntry => t !== null)
  if (Array.isArray(approvals)) message.approvals = approvals.map(parseApproval).filter((a): a is ApprovalEntry => a !== null)
  if (from === 'system') {
    if (!NOTICES.includes(notice as NoticeKind)) return null
    message.notice = notice as NoticeKind
    if (AGENT_IDS.includes(implementer as AgentId)) message.implementer = implementer as AgentId
    if (isString(detail)) message.detail = detail
  }
  return message
}

function parseParticipant(raw: unknown): StoredParticipant {
  const record = isRecord(raw) ? raw : {}
  const delivered = Array.isArray(record.delivered) ? record.delivered.filter((n): n is number => Number.isSafeInteger(n)) : []
  return {
    model: isString(record.model) && record.model ? record.model : null,
    effort: isEffort(record.effort) ? record.effort : null,
    sessionId: isString(record.sessionId) && record.sessionId ? record.sessionId : null,
    delivered,
  }
}

/** Reads a conversation file, keeping whatever is valid. Throws if it is not a conversation at all. */
export function parseConversation(raw: unknown, id: string): ConversationData {
  if (!isRecord(raw)) throw new Error('会話のファイルではありません')
  if (raw.version !== FORMAT_VERSION) throw new Error(`対応していない形式です（version ${String(raw.version)}）`)
  const messages = Array.isArray(raw.messages) ? raw.messages.map(parseMessage).filter((m): m is ChatMessage => m !== null) : []
  const participants = isRecord(raw.participants) ? raw.participants : {}
  const fallbackTime = messages.at(-1)?.at ?? new Date(0).toISOString()
  const code = raw.kind === 'code' && isString(raw.workdir) && path.isAbsolute(raw.workdir)
  return {
    version: FORMAT_VERSION,
    id,
    title: isString(raw.title) && raw.title.trim() ? raw.title : DEFAULT_TITLE,
    kind: code ? 'code' : 'chat',
    workdir: code ? (raw.workdir as string) : null,
    approvalMode: raw.approvalMode === 'always' || raw.approvalMode === 'auto' ? 'auto' : 'ask',
    roles: AGENT_IDS.includes(raw.roles as AgentId) ? (raw.roles as Roles) : 'single',
    pinned: raw.pinned === true,
    createdAt: isString(raw.createdAt) ? raw.createdAt : (messages[0]?.at ?? fallbackTime),
    updatedAt: isString(raw.updatedAt) ? raw.updatedAt : fallbackTime,
    participants: Object.fromEntries(AGENT_IDS.map((agent) => [agent, parseParticipant(participants[agent])])) as Record<AgentId, StoredParticipant>,
    messages,
  }
}

/**
 * Keeps each conversation in its own small JSON file.
 * Files are written atomically (temp file + rename) and readable only by the user.
 */
export class ConversationStore {
  readonly attachments: AttachmentStore

  constructor(readonly directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    this.attachments = new AttachmentStore(path.join(directory, 'attachments'))
  }

  /** Every readable conversation, newest first. Unreadable files are skipped and left alone. */
  list(): ConversationData[] {
    const conversations: ConversationData[] = []
    for (const name of readdirSync(this.directory)) {
      const id = FILE_NAME.exec(name)?.[1]
      if (!id) continue
      try {
        conversations.push(this.read(id))
      } catch (error) {
        console.warn(`[store] skipped ${name}:`, error instanceof Error ? error.message : error)
      }
    }
    return conversations.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  load(id: string): ConversationData {
    return this.read(id)
  }

  save(data: ConversationData): void {
    const file = this.file(data.id)
    const temporary = path.join(this.directory, `.${data.id}.json.tmp`)
    writeFileSync(temporary, JSON.stringify(data, null, 2) + '\n', {
      encoding: 'utf8',
      mode: 0o600,
    })
    renameSync(temporary, file)
  }

  remove(id: string): void {
    rmSync(this.file(id), { force: true })
    this.attachments.remove(id)
  }

  private read(id: string): ConversationData {
    return parseConversation(JSON.parse(readFileSync(this.file(id), 'utf8')), id)
  }

  private file(id: string): string {
    if (!isConversationId(id)) throw new Error('会話の ID が不正です')
    return path.join(this.directory, `${id}.json`)
  }
}
