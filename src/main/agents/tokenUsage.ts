import type { TokenUsage } from '../../shared/types'
import { parseTokenUsage } from '../../shared/validate'

export const ZERO_TOKENS: TokenUsage = {
  inputTokens: 0,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  outputTokens: 0,
}

export function addTokenUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
    cacheWriteInputTokens: a.cacheWriteInputTokens + b.cacheWriteInputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
  }
}

/** A decrease in a cumulative counter means its previous value can't be used as a baseline. */
export function tokenUsageDelta(total: TokenUsage, previous: TokenUsage): TokenUsage | undefined {
  return parseTokenUsage({
    inputTokens: total.inputTokens - previous.inputTokens,
    cachedInputTokens: total.cachedInputTokens - previous.cachedInputTokens,
    cacheWriteInputTokens: total.cacheWriteInputTokens - previous.cacheWriteInputTokens,
    outputTokens: total.outputTokens - previous.outputTokens,
  })
}
