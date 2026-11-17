import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  AGENT_IDS,
  DEFAULT_TITLE,
  type AgentId,
  type ChatMessage,
  type MessageStatus,
  type Recipient,
  type Sender,
} from '../../shared/types'
import { isConversationId, isEffort } from '../../shared/validate'

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
}

/** One conversation file: `conversations/<id>.json`. */
export interface ConversationData extends ConversationContent {
  version: 1
  id: string
  kind: 'chat'
  workdir: null
  createdAt: string
  updatedAt: string
}

const FORMAT_VERSION = 1
const FILE_NAME = /^([a-z0-9][a-z0-9-]{0,63})\.json$/
const SENDERS: readonly Sender[] = ['user', ...AGENT_IDS]
const RECIPIENTS: readonly Recipient[] = ['all', ...SENDERS]
const STATUSES: readonly MessageStatus[] = ['streaming', 'done', 'stopped', 'error']

const isString = (value: unknown): value is string => typeof value === 'string'
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

function parseMessage(raw: unknown): ChatMessage | null {
  if (!isRecord(raw)) return null
  const { id, from, to, text, at, status, error } = raw
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
  const messages = Array.isArray(raw.messages)
    ? raw.messages.map(parseMessage).filter((m): m is ChatMessage => m !== null)
    : []
  const participants = isRecord(raw.participants) ? raw.participants : {}
  const fallbackTime = messages.at(-1)?.at ?? new Date(0).toISOString()
  return {
    version: FORMAT_VERSION,
    id,
    title: isString(raw.title) && raw.title.trim() ? raw.title : DEFAULT_TITLE,
    kind: 'chat',
    workdir: null,
    createdAt: isString(raw.createdAt) ? raw.createdAt : (messages[0]?.at ?? fallbackTime),
    updatedAt: isString(raw.updatedAt) ? raw.updatedAt : fallbackTime,
    participants: Object.fromEntries(AGENT_IDS.map((agent) => [agent, parseParticipant(participants[agent])])) as Record<
      AgentId,
      StoredParticipant
    >,
    messages,
  }
}

/**
 * Keeps each conversation in its own small JSON file.
 * Files are written atomically (temp file + rename) and readable only by the user.
 */
export class ConversationStore {
  constructor(readonly directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
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
    writeFileSync(temporary, JSON.stringify(data, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
    renameSync(temporary, file)
  }

  remove(id: string): void {
    rmSync(this.file(id), { force: true })
  }

  private read(id: string): ConversationData {
    return parseConversation(JSON.parse(readFileSync(this.file(id), 'utf8')), id)
  }

  private file(id: string): string {
    if (!isConversationId(id)) throw new Error('会話の ID が不正です')
    return path.join(this.directory, `${id}.json`)
  }
}
