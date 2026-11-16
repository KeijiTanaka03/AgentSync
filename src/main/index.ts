import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import type { AgentId, ChatEventEnvelope } from '../shared/types'
import { parseSendRequest } from '../shared/validate'
import { ClaudeAdapter } from './agents/claude'
import { CodexAdapter } from './agents/codex'
import { StdioRpcConnection } from './agents/jsonRpc'
import { Orchestrator } from './chat/orchestrator'
import { childEnv, findExecutable, loadLoginShellPath } from './env'

app.setName('AgentSync')

let mainWindow: BrowserWindow | null = null
let orchestrator: Orchestrator | null = null

/** Only http(s) links leave the app, and they open in the default browser. */
function openExternally(url: string): void {
  try {
    const { protocol } = new URL(url)
    if (protocol === 'https:' || protocol === 'http:') void shell.openExternal(url)
  } catch {
    // ignore malformed URLs
  }
}

async function requireExecutable(name: string, label: string, override?: string): Promise<string> {
  const found = await findExecutable(name, override)
  if (found) return found
  throw new Error(
    `${label}（${name}）が見つかりません。インストールしてログインしてから、AgentSync を起動し直してください。`,
  )
}

/** Optional model overrides for development, e.g. AGENTSYNC_CLAUDE_MODEL=haiku. */
function modelFromEnv(id: AgentId): string | null {
  const value = process.env[id === 'claude' ? 'AGENTSYNC_CLAUDE_MODEL' : 'AGENTSYNC_GPT_MODEL']
  return value && value.trim() ? value.trim() : null
}

function createOrchestrator(): Orchestrator {
  const chatDirectory = path.join(app.getPath('userData'), 'chat-workdir')
  mkdirSync(chatDirectory, { recursive: true })

  const claude = new ClaudeAdapter({
    resolveBinary: () => requireExecutable('claude', 'Claude Code CLI', process.env.AGENTSYNC_CLAUDE_PATH),
    env: () => childEnv(),
  })
  const gpt = new CodexAdapter({
    clientVersion: app.getVersion(),
    connect: async () => {
      const binary = await requireExecutable('codex', 'Codex CLI', process.env.AGENTSYNC_CODEX_PATH)
      return new StdioRpcConnection(binary, ['app-server'], { cwd: chatDirectory, env: childEnv() })
    },
  })

  return new Orchestrator({
    adapters: { claude, gpt },
    cwd: chatDirectory,
    models: { claude: modelFromEnv('claude'), gpt: modelFromEnv('gpt') },
    emit: (envelope: ChatEventEnvelope) => {
      for (const window of BrowserWindow.getAllWindows()) window.webContents.send('chat:event', envelope)
    },
  })
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 720,
    minHeight: 520,
    show: false,
    title: 'AgentSync',
    backgroundColor: '#FAF9F5',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  })

  window.once('ready-to-show', () => window.show())
  window.webContents.setWindowOpenHandler(({ url }) => {
    openExternally(url)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event, url) => {
    if (url !== window.webContents.getURL()) {
      event.preventDefault()
      openExternally(url)
    }
  })
  // Closing the window stops any reply in progress (and, later, dialog mode).
  window.on('closed', () => {
    orchestrator?.stop()
    if (mainWindow === window) mainWindow = null
  })

  const devServerUrl = process.env.ELECTRON_RENDERER_URL
  if (!app.isPackaged && devServerUrl) void window.loadURL(devServerUrl)
  else void window.loadFile(path.join(__dirname, '../renderer/index.html'))
  return window
}

/** Accept IPC only from our own window. */
function fromMainWindow(event: Electron.IpcMainInvokeEvent): boolean {
  return mainWindow !== null && event.sender === mainWindow.webContents
}

function registerIpc(): void {
  ipcMain.handle('chat:snapshot', (event) => {
    if (!fromMainWindow(event) || !orchestrator) throw new Error('利用できません')
    return orchestrator.snapshot()
  })
  ipcMain.handle('chat:send', (event, raw: unknown) => {
    if (!fromMainWindow(event) || !orchestrator) throw new Error('利用できません')
    orchestrator.send(parseSendRequest(raw))
  })
  ipcMain.handle('chat:stop', (event) => {
    if (!fromMainWindow(event) || !orchestrator) throw new Error('利用できません')
    orchestrator.stop()
  })
}

void app.whenReady().then(async () => {
  await loadLoginShellPath()
  orchestrator = createOrchestrator()
  registerIpc()
  mainWindow = createWindow()

  const selfTestOutput = process.env.AGENTSYNC_SELFTEST
  if (!app.isPackaged && selfTestOutput) {
    const { runSelfTest } = await import('./selftest')
    void runSelfTest(mainWindow, orchestrator, selfTestOutput)
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  orchestrator?.dispose()
})
