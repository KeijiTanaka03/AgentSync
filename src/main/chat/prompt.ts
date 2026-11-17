import { otherAgent, type AgentId, type ChatMessage, type Recipient, type Sender } from '../../shared/types'

/** Names used inside prompts (the UI calls the user 「あなた」, the agents see 「ユーザー」). */
const PROMPT_NAMES: Record<Sender, string> = {
  user: 'ユーザー',
  claude: 'Claude',
  gpt: 'GPT',
  system: 'AgentSync',
}

/** The reviewer named by a `review-diff` notice (the agent that did not implement). */
function reviewerOf(message: ChatMessage): AgentId {
  return otherAgent(message.implementer ?? 'claude')
}

/** The reviewer's sign that the changes are fine: APPROVED on the first line (Markdown marks allowed). */
export function isApproved(reply: string): boolean {
  const first = reply.split('\n').find((line) => line.trim() !== '') ?? ''
  return /^[\s*_`#>]*APPROVED\b/.test(first)
}

/** What a notice in the timeline tells each agent. */
function noticeForAgent(message: ChatMessage, self: AgentId): string {
  const other = PROMPT_NAMES[otherAgent(self)]
  switch (message.notice) {
    case 'dialogue-start':
      return [
        `ここから「対話モード」です。あなたと ${other} が交互に発言し、ユーザーが止めるまで続きます。`,
        `${other} の発言に応じて、賛成・反論・補足・質問などで話を前に進めてください。同じことの繰り返しは避けてください。`,
        'ユーザーの発言が途中で届いたら、それも踏まえてください。',
      ].join('')
    case 'dialogue-stop':
      return '対話モードが終わりました。ここからは普段のチャットに戻ります。'
    case 'review-start': {
      const implementer = message.implementer ?? 'claude'
      return implementer === self
        ? [
            `ここから「実装＋レビュー」です。あなたが実装役、${other} がレビュー役です。`,
            '直前のユーザーの依頼を実装し、必要ならテストも実行してください。終わったら、何を変えたかを短くまとめてください。',
            `あなたの作業が終わるたびに、アプリが変更（git diff）を ${other} に渡します。${other} の指摘が届いたら、それに従って直してください。`,
          ].join('')
        : [
            `ここから「実装＋レビュー」です。${other} が実装役、あなたがレビュー役です。`,
            `${other} の作業が終わるたびに、依頼と変更（git diff）が届きます。読み取り専用で確かめ、問題があれば具体的に（ファイル・場所・直し方）指摘してください。`,
            '問題がなければ、返事の最初の行に APPROVED とだけ書いてください。',
          ].join('')
    }
    case 'review-diff': {
      const diff = message.detail ?? ''
      return message.implementer === self || self !== reviewerOf(message)
        ? `いまの変更（git diff）を、レビュー役の ${other} に渡しました。`
        : [
            `${other} の作業が終わりました。いまの変更（git diff）です。`,
            diff ? `\n\n\`\`\`diff\n${diff}\n\`\`\`\n\n` : '（差分を取れませんでした。git のリポジトリではないか、変更がありません）\n\n',
            '読み取り専用でレビューしてください。問題があれば具体的に指摘してください。問題がなければ、返事の最初の行に APPROVED とだけ書いてください。',
          ].join('')
    }
    case 'review-stop':
      return '実装＋レビューが終わりました。ここからは普段のチャットに戻ります。'
    default:
      return message.text
  }
}

function recipientLabel(to: Recipient, self: AgentId): string {
  if (to === 'all') return '全員'
  if (to === self) return 'あなた'
  return PROMPT_NAMES[to]
}

/**
 * Messages the agent has not received yet.
 * The agent's own messages are already in its CLI session, so they are skipped.
 * Messages still streaming are skipped too; they are delivered on a later turn.
 */
export function collectUnseen(messages: readonly ChatMessage[], self: AgentId, delivered: ReadonlySet<number>): ChatMessage[] {
  return messages.filter(
    (m) => !delivered.has(m.id) && m.from !== self && m.status !== 'streaming' && m.text.trim() !== '',
  )
}

/** Formats unseen messages as one prompt, each with a 【sender → recipient】 heading. */
export function formatUnseen(unseen: readonly ChatMessage[], self: AgentId): string {
  return unseen
    .map((m) => {
      if (m.from === 'system') return `【AgentSync からのお知らせ】\n${noticeForAgent(m, self)}`
      const note = m.status === 'stopped' ? '\n（この発言は途中で止められました）' : ''
      return `【${PROMPT_NAMES[m.from]} → ${recipientLabel(m.to, self)}】\n${m.text.trim()}${note}`
    })
    .join('\n\n')
}

/** Who the agent is answering: the sender of the last message addressed to it (or to everyone). */
export function replyTarget(unseen: readonly ChatMessage[], self: AgentId): Recipient {
  for (let i = unseen.length - 1; i >= 0; i--) {
    const m = unseen[i]!
    if (m.from !== 'system' && (m.to === self || m.to === 'all')) return m.from
  }
  return 'user'
}

/** For a coding conversation: what the agent may do on this turn, said at the start of its prompt. */
export function turnNote(access: 'read' | 'write', approval: 'ask' | 'auto', folder: string): string {
  const note =
    access === 'write'
      ? `このターンでは、作業フォルダ（${folder}）のファイルの変更とコマンドの実行ができます。${
          approval === 'auto' ? '承認なしで進められます（auto）。' : '変更とコマンドの実行の前には、ユーザーの承認を求めます（承認制）。'
        }`
      : 'このターンは読み取り専用です。ファイルを読んだり検索したりするコマンド（cat・sed -n・rg・ls など）は使えます。ファイルを変更する操作と、変更を伴うコマンドはしないでください。'
  return `【AgentSync からのお知らせ】\n${note}`
}

/** For a coding conversation: the group chat explained on top of the CLI's own coding instructions. */
export function codeSystemPrompt(self: AgentId, workdir: string): string {
  const other = self === 'claude' ? 'GPT' : 'Claude'
  return [
    `あなたは「${PROMPT_NAMES[self]}」として、グループチャットに参加しています。参加者は、ユーザー（人間）、Claude、GPT の 3 人です。`,
    `このチャットは、プロジェクトのフォルダ ${workdir} での開発に使われています。`,
    '',
    '- 新しい発言は「【発言者 → 宛先】」という見出し付きで届きます。あなたが前回発言したあとに増えた分が、まとめて届きます。',
    '- 宛先が「あなた」か「全員」の発言に応えてください。それ以外の発言は、会話の流れとして読んでおいてください。',
    `- ${other} は、同じチャットにいる別の AI です。${other} の発言や変更には、賛成・反対・補足など、自分の考えで応じて構いません。`,
    '- 各ターンの最初に「【AgentSync からのお知らせ】」で、そのターンにできること（読み取り専用か、ファイルの変更とコマンドの実行ができるか）が届きます。従ってください。お知らせそのものには、返事の中で触れなくて構いません（承認はアプリが取ります）。',
    '- ファイルを変更するのは作業フォルダの中だけにしてください。',
    '- ウェブ検索や、つないである連携（Notion など）も使えます。何かを変える操作は、アプリがユーザーの承認を取ります。',
    '- あなたの返答は、そのままあなたの吹き出しとしてチャットに表示されます。見出しや自分の名前を先頭に付けないでください。',
    '- ユーザーと同じ言語で答えてください。作業をしたときは、何を変えたかを短くまとめてください。Markdown を使えます。',
  ].join('\n')
}

export function chatSystemPrompt(self: AgentId): string {
  const other = self === 'claude' ? 'GPT' : 'Claude'
  return [
    `あなたは「${PROMPT_NAMES[self]}」として、グループチャットに参加しています。参加者は、ユーザー（人間）、Claude、GPT の 3 人です。`,
    '',
    '- 新しい発言は「【発言者 → 宛先】」という見出し付きで届きます。あなたが前回発言したあとに増えた分が、まとめて届きます。',
    '- 宛先が「あなた」か「全員」の発言に返答してください。それ以外の発言は、会話の流れとして読んでおいてください。',
    `- ${other} は、同じチャットにいる別の AI です。${other} の発言には、賛成・反対・補足など、自分の考えで応じて構いません。`,
    '- 「【AgentSync からのお知らせ】」は、このチャットのアプリからの案内です。従ってください。',
    '- ウェブ検索や、つないである連携（Notion など）は、普段どおり使って構いません。作成・変更・削除のように何かを変える操作は、実行の前にアプリがユーザーの承認を取ります。',
    '- あなたの返答は、そのままあなたの吹き出しとしてチャットに表示されます。見出しや自分の名前を先頭に付けないでください。',
    '- ユーザーと同じ言語で、チャットらしく簡潔に答えてください。Markdown を使えます。',
  ].join('\n')
}
