import type { TokenUsage } from '../../../shared/types'

const number = new Intl.NumberFormat('ja-JP')

export function TokenUsageLine({ usage }: { usage: TokenUsage }) {
  return (
    <div className="token-usage" role="group" aria-label="使用トークン数">
      <span title="キャッシュの読み込みと書き込みを含む入力の合計">入力 {number.format(usage.inputTokens)}</span>
      <span>キャッシュ読込 {number.format(usage.cachedInputTokens)}</span>
      <span>書込 {number.format(usage.cacheWriteInputTokens)}</span>
      <span>出力 {number.format(usage.outputTokens)}</span>
    </div>
  )
}
