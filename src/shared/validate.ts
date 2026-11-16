import { AGENT_IDS, MAX_MESSAGE_LENGTH, type SendRequest, type SendTarget } from './types'

const TARGETS: readonly SendTarget[] = ['all', ...AGENT_IDS]

/** Validates a send request that arrived over IPC. Throws on anything unexpected. */
export function parseSendRequest(raw: unknown): SendRequest {
  if (typeof raw !== 'object' || raw === null) throw new Error('不正なリクエストです')
  const { text, to } = raw as Record<string, unknown>
  if (typeof text !== 'string') throw new Error('メッセージが文字列ではありません')
  if (text.length > MAX_MESSAGE_LENGTH) throw new Error('メッセージが長すぎます')
  if (typeof to !== 'string' || !TARGETS.includes(to as SendTarget)) throw new Error('宛先が不正です')
  return { text, to: to as SendTarget }
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
