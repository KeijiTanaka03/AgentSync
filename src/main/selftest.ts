// Development-only self test: drives the real UI once and saves screenshots of the window
// (one while a reply is streaming, one when both replies are done).
// Usage: AGENTSYNC_SELFTEST=/path/to/out.png npm run dev
// Optional: AGENTSYNC_SELFTEST_PROMPT, AGENTSYNC_SELFTEST_THEME=dark|light,
//           AGENTSYNC_CLAUDE_MODEL, AGENTSYNC_GPT_MODEL
import { app, nativeTheme, type BrowserWindow } from 'electron'
import { writeFileSync } from 'node:fs'
import type { Orchestrator } from './chat/orchestrator'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function capture(window: BrowserWindow, outputPath: string): Promise<void> {
  const image = await window.webContents.capturePage()
  writeFileSync(outputPath, image.toPNG())
  console.log(`[selftest] screenshot saved: ${outputPath}`)
}

export async function runSelfTest(window: BrowserWindow, orchestrator: Orchestrator, outputPath: string): Promise<void> {
  const prompt = process.env.AGENTSYNC_SELFTEST_PROMPT ?? '自己紹介を一言でお願いします。'
  const theme = process.env.AGENTSYNC_SELFTEST_THEME
  if (theme === 'dark' || theme === 'light') nativeTheme.themeSource = theme
  try {
    if (window.webContents.isLoading()) {
      await new Promise<void>((resolve) => window.webContents.once('did-finish-load', () => resolve()))
    }
    await sleep(800)

    // Type into the composer and press the send button, as a person would.
    await window.webContents.executeJavaScript(`(() => {
      const box = document.querySelector('textarea')
      const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
      setValue.call(box, ${JSON.stringify(prompt)})
      box.dispatchEvent(new Event('input', { bubbles: true }))
    })()`)
    await sleep(200)
    await window.webContents.executeJavaScript(`document.querySelector('[data-testid="send"]').click()`)

    const deadline = Date.now() + 180_000
    let streamingCaptured = false
    for (;;) {
      const { state } = orchestrator.snapshot()
      const replies = state.messages.filter((m) => m.from !== 'user')
      if (!streamingCaptured && replies.some((m) => m.status === 'streaming' && m.text.length > 20)) {
        streamingCaptured = true
        await capture(window, outputPath.replace(/\.png$/, '') + '-streaming.png')
      }
      const settled = replies.length >= 2 && replies.every((m) => m.status !== 'streaming')
      if (settled || Date.now() > deadline) {
        console.log('[selftest] messages:', JSON.stringify(state.messages.map((m) => ({ from: m.from, to: m.to, status: m.status, error: m.error, text: m.text.slice(0, 120) }))))
        break
      }
      await sleep(100)
    }
    await sleep(600)
    await capture(window, outputPath)
  } catch (error) {
    console.error('[selftest] failed:', error)
  } finally {
    app.quit()
  }
}
