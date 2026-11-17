// Development-only self test: drives the real UI once and saves screenshots of the window
// (while a reply is streaming, when the replies are done, and after pressing 「新しい会話」).
// Usage: AGENTSYNC_SELFTEST=/path/to/out.png npm run dev
// Optional: AGENTSYNC_SELFTEST_PROMPT, AGENTSYNC_SELFTEST_THEME=dark|light,
//           AGENTSYNC_SELFTEST_DATA=<folder> (keep data between runs to test resuming),
//           AGENTSYNC_CLAUDE_MODEL, AGENTSYNC_GPT_MODEL
import { app, nativeTheme, type BrowserWindow } from 'electron'
import { writeFileSync } from 'node:fs'
import type { ChatManager } from './chat/manager'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Saves a screenshot of the page. Uses the DevTools protocol, which renders a fresh frame even when
 * the window is behind other windows (`capturePage` can return an old frame then).
 */
async function capture(window: BrowserWindow, outputPath: string): Promise<void> {
  const devtools = window.webContents.debugger
  if (!devtools.isAttached()) devtools.attach('1.3')
  const { data } = (await devtools.sendCommand('Page.captureScreenshot', { format: 'png' })) as { data: string }
  writeFileSync(outputPath, Buffer.from(data, 'base64'))
  // What the page shows, to compare with the picture.
  const bubbles = (await window.webContents.executeJavaScript(
    `[...document.querySelectorAll('.bubble-agent')].map((b) => b.textContent.slice(0, 30))`,
  )) as string[]
  console.log(`[selftest] screenshot saved: ${outputPath} (bubbles ${JSON.stringify(bubbles)})`)
}

function variant(outputPath: string, suffix: string): string {
  return outputPath.replace(/\.png$/, '') + `-${suffix}.png`
}

export async function runSelfTest(window: BrowserWindow, manager: ChatManager, outputPath: string): Promise<void> {
  const prompt = process.env.AGENTSYNC_SELFTEST_PROMPT ?? '自己紹介を一言でお願いします。'
  const theme = process.env.AGENTSYNC_SELFTEST_THEME
  if (theme === 'dark' || theme === 'light') nativeTheme.themeSource = theme
  try {
    if (window.webContents.isLoading()) {
      await new Promise<void>((resolve) => window.webContents.once('did-finish-load', () => resolve()))
    }
    await sleep(1000)
    const before = manager.list()
    console.log('[selftest] conversations at start:', JSON.stringify(before.map((c) => c.title)))

    // Type into the composer and press the send button, as a person would.
    await window.webContents.executeJavaScript(`(() => {
      const box = document.querySelector('textarea')
      const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
      setValue.call(box, ${JSON.stringify(prompt)})
      box.dispatchEvent(new Event('input', { bubbles: true }))
    })()`)
    await sleep(200)
    await window.webContents.executeJavaScript(`document.querySelector('[data-testid="send"]').click()`)
    await sleep(300)

    // The conversation just written to is the newest one.
    const id = manager.list()[0]!.id
    const sentAt = manager.snapshot(id).state.messages.filter((m) => m.from === 'user').at(-1)!.id
    const deadline = Date.now() + 180_000
    let streamingCaptured = false
    for (;;) {
      const { state } = manager.snapshot(id)
      const replies = state.messages.filter((m) => m.from !== 'user' && m.id > sentAt)
      if (!streamingCaptured && replies.some((m) => m.status === 'streaming' && m.text.length > 20)) {
        streamingCaptured = true
        await capture(window, variant(outputPath, 'streaming'))
      }
      const settled = replies.length >= 2 && replies.every((m) => m.status !== 'streaming')
      if (settled || Date.now() > deadline) {
        console.log(
          '[selftest] messages:',
          JSON.stringify(state.messages.map((m) => ({ id: m.id, from: m.from, to: m.to, status: m.status, error: m.error, text: m.text.slice(0, 120) }))),
        )
        break
      }
      await sleep(100)
    }
    await sleep(800)
    await capture(window, outputPath)

    // A new conversation from the sidebar.
    await window.webContents.executeJavaScript(`document.querySelector('.new-conversation').click()`)
    await sleep(800)
    await capture(window, variant(outputPath, 'new'))
    console.log('[selftest] conversations at end:', JSON.stringify(manager.list().map((c) => c.title)))
  } catch (error) {
    console.error('[selftest] failed:', error)
  } finally {
    app.quit()
  }
}
