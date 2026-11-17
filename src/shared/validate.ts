import {
  AGENT_IDS,
  MAX_MESSAGE_LENGTH,
  MAX_TITLE_LENGTH,
  type AgentId,
  type ApprovalDecision,
  type ApprovalMode,
  type SendRequest,
  type SendTarget,
  type Roles,
} from './types'

const TARGETS: readonly SendTarget[] = ['all', ...AGENT_IDS]

/** Conversation IDs are also file names, so only a narrow set of characters is allowed. */
const CONVERSATION_ID = /^[a-z0-9][a-z0-9-]{0,63}$/

export function isConversationId(value: unknown): value is string {
  return typeof value === 'string' && CONVERSATION_ID.test(value)
}

/** Validates a conversation ID that arrived over IPC. */
export function parseConversationId(raw: unknown): string {
  if (!isConversationId(raw)) throw new Error('会話の ID が不正です')
  return raw
}

/** Validates an agent ID that arrived over IPC. */
export function parseAgentId(raw: unknown): AgentId {
  if (typeof raw !== 'string' || !AGENT_IDS.includes(raw as AgentId)) throw new Error('AI の指定が不正です')
  return raw as AgentId
}

/** Reasoning effort names (`low`, `xhigh`, …). They are passed to the CLIs as arguments, so keep them plain. */
const EFFORT = /^[a-z][a-z0-9-]{0,23}$/

export function isEffort(value: unknown): value is string {
  return typeof value === 'string' && EFFORT.test(value)
}

/** Validates a reasoning effort that arrived over IPC. Null means 「the CLI's own setting」. */
export function parseEffort(raw: unknown): string | null {
  if (raw === null) return null
  if (!isEffort(raw)) throw new Error('effort の指定が不正です')
  return raw
}

/**
 * Model aliases and IDs (`sonnet`, `opus[1m]`, `claude-haiku-4-5-20251001`, `gpt-6.1-sol`). They are passed to
 * the CLIs as arguments, so they must not start with `-`.
 */
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/@[\]-]{0,99}$/

export function isModel(value: unknown): value is string {
  return typeof value === 'string' && MODEL.test(value)
}

/** Validates a model that arrived over IPC. Null means 「the CLI's own setting」. */
export function parseModel(raw: unknown): string | null {
  if (raw === null) return null
  if (!isModel(raw)) throw new Error('モデルの指定が不正です')
  return raw
}

/** Validates the answer to an approval card that arrived over IPC. */
export function parseApproval(id: unknown, decision: unknown): { id: string; decision: ApprovalDecision } {
  if (typeof id !== 'string' || !/^\d{1,9}-\d{1,9}$/.test(id)) throw new Error('承認の指定が不正です')
  if (decision !== 'allow' && decision !== 'allow-all' && decision !== 'deny') throw new Error('承認の指定が不正です')
  return { id, decision }
}

export function parseRoles(raw: unknown): Roles {
  if (raw !== 'single' && !AGENT_IDS.includes(raw as AgentId)) throw new Error('役割の指定が不正です')
  return raw as Roles
}

export function parseApprovalMode(raw: unknown): ApprovalMode {
  if (raw !== 'ask' && raw !== 'auto') throw new Error('承認の方式が不正です')
  return raw
}

/** Validates a send request that arrived over IPC. Throws on anything unexpected. */
export function parseSendRequest(raw: unknown): SendRequest {
  if (typeof raw !== 'object' || raw === null) throw new Error('不正なリクエストです')
  const { text, to } = raw as Record<string, unknown>
  if (typeof text !== 'string') throw new Error('メッセージが文字列ではありません')
  if (text.length > MAX_MESSAGE_LENGTH) throw new Error('メッセージが長すぎます')
  if (typeof to !== 'string' || !TARGETS.includes(to as SendTarget)) throw new Error('宛先が不正です')
  return { text, to: to as SendTarget }
}

/** Validates a new conversation title. Returns it on one line, trimmed. */
export function parseTitle(raw: unknown): string {
  if (typeof raw !== 'string') throw new Error('タイトルが文字列ではありません')
  const title = raw.replace(/\s+/g, ' ').trim()
  if (!title) throw new Error('タイトルが空です')
  return title.length > MAX_TITLE_LENGTH ? title.slice(0, MAX_TITLE_LENGTH) : title
}

/** A title made from the first message: its first non-empty line, cut short. */
export function titleFromMessage(text: string, maxLength = 40): string {
  const line = text
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .find((l) => l !== '')
  if (!line) return ''
  const chars = Array.from(line)
  return chars.length > maxLength ? chars.slice(0, maxLength).join('') + '…' : line
}

/**
 * Reads a leading mention such as `@Claude` or `@GPT` and returns the target it selects,
 * together with the text without the mention. Returns null when there is no mention.
 */
export function parseLeadingMention(text: string): { to: SendTarget; text: string } | null {
  const match = /^\s*@(claude|gpt|all|全員)(?=\s|$)\s*/i.exec(text)
  if (!match) return null
  const word = match[1]!.toLowerCase()
  const to: SendTarget = word === 'claude' ? 'claude' : word === 'gpt' ? 'gpt' : 'all'
  return { to, text: text.slice(match[0].length) }
}
