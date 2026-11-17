import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ApprovalCard, WorkLog } from '../src/renderer/src/components/WorkLog'
import type { ApprovalEntry } from '../src/shared/types'

describe('WorkLog', () => {
  it('lists the steps, open while the reply is coming in', () => {
    const tools = [
      { id: 't1', kind: 'read', title: 'src/a.ts', status: 'done' },
      { id: 't2', kind: 'command', title: 'npm test', status: 'failed' },
      { id: 't3', kind: 'edit', title: 'src/b.ts', status: 'running' },
    ] as const
    const live = renderToStaticMarkup(<WorkLog tools={[...tools]} live />)
    expect(live).toContain('<details class="work-log" open="">')
    expect(live).toContain('作業ログ（3 件・実行中 1・失敗 1）')
    expect(live).toContain('<code title="npm test">npm test</code>')
    // The running row keeps its own class; only the dot at its end is the small blinking mark.
    expect(live).toContain('<li class="work-step work-running">')
    expect(live).toContain('<span class="work-dot" aria-label="実行中"></span>')
    expect(renderToStaticMarkup(<WorkLog tools={[...tools]} live={false} />)).toContain('<details class="work-log">')
  })
})

describe('ApprovalCard', () => {
  const card: ApprovalEntry = { id: '2-1', kind: 'edit', title: 'ファイルを編集: a.ts', detail: '--- a.ts\n-old\n+new', status: 'pending' }

  it('asks with the three answers and colours a diff', () => {
    const html = renderToStaticMarkup(<ApprovalCard approval={card} onAnswer={() => {}} />)
    expect(html).toContain('ファイルを編集: a.ts')
    expect(html).toContain('<span class="diff-del">-old')
    expect(html).toContain('<span class="diff-add">+new')
    for (const label of ['許可', '今回は全部許可', '拒否']) expect(html).toContain(`>${label}</button>`)
  })

  it('becomes a line once answered', () => {
    expect(renderToStaticMarkup(<ApprovalCard approval={{ ...card, status: 'denied' }} onAnswer={() => {}} />)).toContain('許可しませんでした: ファイルを編集: a.ts')
    expect(renderToStaticMarkup(<ApprovalCard approval={{ ...card, status: 'allowed' }} onAnswer={() => {}} />)).toContain('許可しました: ファイルを編集: a.ts')
  })
})
