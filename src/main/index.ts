import { app, BrowserWindow, dialog, ipcMain, Menu, shell, type MenuItemConstructorOptions } from 'electron'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { AgentId, MenuCommand } from '../shared/types'
import { parseAgentId, parseConversationId, parseEffort, parseSendRequest, parseTitle } from '../shared/validate'
import { ClaudeAdapter } from './agents/claude'
import { CodexAdapter } from './agents/codex'
import { StdioRpcConnection } from './agents/jsonRpc'
import { ChatManager } from './chat/manager'
import { childEnv, findExecutable, loadLoginShellPath } from './env'
import { ConversationStore } from './store/conversationStore'
import { SettingsStore } from './store/settingsStore'

app.setName('AgentSync')

// Keep development data apart from the installed app's data.
// A self test gets a throwaway folder unless it is given one to reuse.
if (!app.isPackaged) {
  const selfTestData = process.env.AGENTSYNC_SELFTEST
    ? process.env.AGENTSYNC_SELFTEST_DATA || mkdtempSync(path.join(tmpdir(), 'agentsync-selftest-'))
    : null
  const userData = selfTestData ?? path.join(app.getPath('appData'), 'AgentSync-dev')
  mkdirSync(userData, { recursive: true })
  app.setPath('userData', userData)
}

let mainWindow: BrowserWindow | null = null
let manager: ChatManager | null = null

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

function broadcast(channel: string, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) window.webContents.send(channel, payload)
}

function createManager(): ChatManager {
  const dataDirectory = app.getPath('userData')
  const chatDirectory = path.join(dataDirectory, 'chat-workdir')
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

  // The last effort chosen for each AI carries over to new conversations.
  const settings = new SettingsStore(path.join(dataDirectory, 'settings.json'))

  return new ChatManager({
    store: new ConversationStore(path.join(dataDirectory, 'conversations')),
    adapters: { claude, gpt },
    cwd: chatDirectory,
    models: { claude: modelFromEnv('claude'), gpt: modelFromEnv('gpt') },
    efforts: settings.load().efforts,
    onEffortsChange: (efforts) => {
      try {
        settings.save({ efforts })
      } catch (error) {
        console.error('[settings] could not save:', error)
      }
    },
    emitEvent: (envelope) => broadcast('chat:event', envelope),
    emitConversations: (conversations) => broadcast('conversations:changed', conversations),
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
  window.webContents.on('did-fail-load', (_event, code, description) => {
    console.error(`[window] failed to load: ${code} ${description}`)
  })
  window.webContents.on('render-process-gone', (_event, details) => {
    console.error(`[window] renderer gone: ${details.reason}`)
  })
  // Closing the window stops every reply in progress (and, later, dialog mode).
  window.on('closed', () => {
    manager?.stopAll()
    manager?.flush()
    if (mainWindow === window) mainWindow = null
  })

  const devServerUrl = process.env.ELECTRON_RENDERER_URL
  if (!app.isPackaged && devServerUrl) void window.loadURL(devServerUrl)
  else void window.loadFile(path.join(__dirname, '../renderer/index.html'))
  return window
}

function showWindow(): BrowserWindow {
  if (!mainWindow) mainWindow = createWindow()
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.focus()
  return mainWindow
}

function sendMenuCommand(command: MenuCommand): void {
  const window = showWindow()
  const deliver = () => window.webContents.send('menu:command', command)
  if (window.webContents.isLoading()) window.webContents.once('did-finish-load', deliver)
  else deliver()
}

function buildMenu(): Menu {
  const name = app.getName()
  const view: MenuItemConstructorOptions[] = [
    { role: 'resetZoom', label: '実際のサイズ' },
    { role: 'zoomIn', label: '拡大' },
    { role: 'zoomOut', label: '縮小' },
    { type: 'separator' },
    { role: 'togglefullscreen', label: 'フルスクリーンにする' },
  ]
  if (!app.isPackaged) {
    view.push({ type: 'separator' }, { role: 'reload', label: '再読み込み' }, { role: 'toggleDevTools', label: '開発者ツール' })
  }
  return Menu.buildFromTemplate([
    {
      label: name,
      submenu: [
        { role: 'about', label: `${name} について` },
        { type: 'separator' },
        { role: 'services', label: 'サービス' },
        { type: 'separator' },
        { role: 'hide', label: `${name} を隠す` },
        { role: 'hideOthers', label: 'ほかを隠す' },
        { role: 'unhide', label: 'すべてを表示' },
        { type: 'separator' },
        { role: 'quit', label: `${name} を終了` },
      ],
    },
    {
      label: 'ファイル',
      submenu: [
        { label: '新規会話', accelerator: 'CmdOrCtrl+N', click: () => sendMenuCommand('new-conversation') },
        { type: 'separator' },
        { role: 'close', label: 'ウインドウを閉じる' },
      ],
    },
    {
      label: '編集',
      submenu: [
        { role: 'undo', label: '取り消す' },
        { role: 'redo', label: 'やり直す' },
        { type: 'separator' },
        { role: 'cut', label: 'カット' },
        { role: 'copy', label: 'コピー' },
        { role: 'paste', label: 'ペースト' },
        { role: 'selectAll', label: 'すべてを選択' },
      ],
    },
    { label: '表示', submenu: view },
    {
      label: 'ウインドウ',
      role: 'window',
      submenu: [
        { role: 'minimize', label: 'しまう' },
        { role: 'zoom', label: '拡大／縮小' },
        { type: 'separator' },
        { role: 'front', label: 'すべてを手前に移動' },
      ],
    },
  ])
}

/** Accept IPC only from our own window. */
function fromMainWindow(event: Electron.IpcMainInvokeEvent): ChatManager {
  if (!manager || !mainWindow || event.sender !== mainWindow.webContents) throw new Error('利用できません')
  return manager
}

async function confirmDelete(id: string, chat: ChatManager): Promise<boolean> {
  const title = chat.list().find((c) => c.id === id)?.title ?? 'この会話'
  const options: Electron.MessageBoxOptions = {
    type: 'warning',
    buttons: ['削除', 'キャンセル'],
    defaultId: 1,
    cancelId: 1,
    message: `「${title}」を削除しますか？`,
    detail: 'AgentSync に残っているこの会話の記録を消します。元には戻せません。Claude Code と Codex 側の履歴は残ります。',
  }
  const { response } = mainWindow ? await dialog.showMessageBox(mainWindow, options) : await dialog.showMessageBox(options)
  return response === 0
}

function registerIpc(): void {
  ipcMain.handle('conversations:list', (event) => fromMainWindow(event).list())
  ipcMain.handle('conversations:create', (event) => fromMainWindow(event).create())
  ipcMain.handle('conversations:rename', (event, id: unknown, title: unknown) => {
    fromMainWindow(event).rename(parseConversationId(id), parseTitle(title))
  })
  ipcMain.handle('conversations:delete', async (event, raw: unknown) => {
    const chat = fromMainWindow(event)
    const id = parseConversationId(raw)
    if (!chat.has(id) || !(await confirmDelete(id, chat))) return false
    chat.delete(id)
    return true
  })
  ipcMain.handle('chat:snapshot', (event, id: unknown) => fromMainWindow(event).snapshot(parseConversationId(id)))
  ipcMain.handle('chat:send', (event, id: unknown, request: unknown) => {
    fromMainWindow(event).send(parseConversationId(id), parseSendRequest(request))
  })
  ipcMain.handle('chat:stop', (event, id: unknown) => {
    fromMainWindow(event).stop(parseConversationId(id))
  })
  ipcMain.handle('agents:choices', (event, id: unknown, agent: unknown) =>
    fromMainWindow(event).agentChoices(parseConversationId(id), parseAgentId(agent)),
  )
  ipcMain.handle('agents:effort', (event, id: unknown, agent: unknown, effort: unknown) => {
    fromMainWindow(event).setEffort(parseConversationId(id), parseAgentId(agent), parseEffort(effort))
  })
}

if (!app.requestSingleInstanceLock()) {
  // Another AgentSync is already running with the same data; it gets focused instead.
  app.quit()
} else {
  app.on('second-instance', () => showWindow())

  void app.whenReady().then(async () => {
    await loadLoginShellPath()
    manager = createManager()
    registerIpc()
    Menu.setApplicationMenu(buildMenu())
    mainWindow = createWindow()

    const selfTestOutput = process.env.AGENTSYNC_SELFTEST
    if (!app.isPackaged && selfTestOutput) {
      const { runSelfTest } = await import('./selftest')
      void runSelfTest(mainWindow, manager, selfTestOutput)
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('before-quit', () => {
    manager?.dispose()
    manager = null
  })
}
