import { app, BrowserWindow, dialog, ipcMain, Menu, session, shell, type MenuItemConstructorOptions } from 'electron'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { AgentId, MenuCommand } from '../shared/types'
import { parseAgentId, parseConversationId, parseEffort, parseModel, parseSendRequest, parseTitle } from '../shared/validate'
import { ClaudeAdapter } from './agents/claude'
import { CodexAdapter } from './agents/codex'
import { StdioRpcConnection } from './agents/jsonRpc'
import { ChatManager } from './chat/manager'
import { childEnv, findExecutable, loadLoginShellPath } from './env'
import { ConversationStore } from './store/conversationStore'
import { SettingsStore, type CliName } from './store/settingsStore'

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
let settings: SettingsStore | null = null
let codexAdapter: CodexAdapter | null = null

const CLI_LABELS: Record<CliName, string> = { claude: 'Claude Code CLI', codex: 'Codex CLI' }

/** Only http(s) links leave the app, and they open in the default browser. */
function openExternally(url: string): void {
  try {
    const { protocol } = new URL(url)
    if (protocol === 'https:' || protocol === 'http:') void shell.openExternal(url)
  } catch {
    // ignore malformed URLs
  }
}

/** A CLI chosen with 「CLI の場所…」 (or, for development, an environment variable). */
function chosenCliPath(name: CliName): string | undefined {
  const fromEnv = name === 'claude' ? process.env.AGENTSYNC_CLAUDE_PATH : process.env.AGENTSYNC_CODEX_PATH
  return fromEnv || settings?.load().cliPaths[name] || undefined
}

async function requireExecutable(name: CliName): Promise<string> {
  const chosen = chosenCliPath(name)
  const found = await findExecutable(name, chosen)
  if (found) return found
  const label = CLI_LABELS[name]
  throw new Error(
    chosen
      ? `指定した場所（${chosen}）に ${label} が見つかりません。アプリのメニューの「AgentSync > CLI の場所…」で指定し直してください。`
      : `${label}（${name}）が見つかりません。インストールしてログインしてから、アプリのメニューの「AgentSync > CLI の場所…」で場所を指定してください。`,
  )
}

/** 「CLI の場所…」: shows where each CLI is and lets you pick another executable. */
async function showCliLocations(): Promise<void> {
  const window = showWindow()
  const store = settings
  if (!store) return
  const describe = async (name: CliName): Promise<string> => {
    const chosen = store.load().cliPaths[name]
    const found = await findExecutable(name, chosen ?? undefined)
    if (chosen) return found ? `${chosen}（指定）` : `${chosen}（指定した場所にありません）`
    return found ? `${found}（自動で見つけました）` : '見つかりません'
  }
  for (;;) {
    const [claude, codex] = await Promise.all([describe('claude'), describe('codex')])
    const { response } = await dialog.showMessageBox(window, {
      type: 'info',
      message: 'CLI の場所',
      detail: `Claude Code: ${claude}\nCodex: ${codex}\n\nCLI が見つからないときや、別の場所にあるものを使いたいときに指定します。`,
      buttons: ['閉じる', 'Claude Code を選ぶ…', 'Codex を選ぶ…', '自動で探すに戻す'],
      defaultId: 0,
      cancelId: 0,
    })
    if (response === 0) return
    if (response === 3) {
      store.update((next) => {
        next.cliPaths = { claude: null, codex: null }
      })
      codexAdapter?.dispose() // the next reply starts Codex again from wherever it is found
      continue
    }
    const name: CliName = response === 1 ? 'claude' : 'codex'
    const picked = await dialog.showOpenDialog(window, {
      title: `${CLI_LABELS[name]} を選ぶ`,
      message: `${name} の実行ファイルを選んでください（例: /opt/homebrew/bin/${name}）`,
      defaultPath: '/opt/homebrew/bin',
      properties: ['openFile', 'showHiddenFiles', 'treatPackageAsDirectory'],
    })
    const file = picked.filePaths[0]
    if (picked.canceled || !file) continue
    if (!(await findExecutable(name, file))) {
      await dialog.showMessageBox(window, { type: 'warning', message: '実行できるファイルではありません', detail: file })
      continue
    }
    store.update((next) => {
      next.cliPaths[name] = file
    })
    if (name === 'codex') codexAdapter?.dispose()
  }
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

  // Models, efforts and CLI locations chosen in the app. The last model and effort chosen for each AI
  // carry over to new conversations.
  const store = new SettingsStore(path.join(dataDirectory, 'settings.json'))
  settings = store
  const saved = store.load()
  const remember = (change: Parameters<SettingsStore['update']>[0]) => {
    try {
      store.update(change)
    } catch (error) {
      console.error('[settings] could not save:', error)
    }
  }

  const claude = new ClaudeAdapter({
    resolveBinary: () => requireExecutable('claude'),
    env: () => childEnv(),
    listCwd: chatDirectory,
  })
  const gpt = new CodexAdapter({
    clientVersion: app.getVersion(),
    connect: async () => {
      const binary = await requireExecutable('codex')
      return new StdioRpcConnection(binary, ['app-server'], { cwd: chatDirectory, env: childEnv() })
    },
  })
  codexAdapter = gpt

  return new ChatManager({
    store: new ConversationStore(path.join(dataDirectory, 'conversations')),
    adapters: { claude, gpt },
    cwd: chatDirectory,
    models: { claude: modelFromEnv('claude') ?? saved.models.claude, gpt: modelFromEnv('gpt') ?? saved.models.gpt },
    efforts: saved.efforts,
    onModelsChange: (models) => remember((next) => void (next.models = models)),
    onEffortsChange: (efforts) => remember((next) => void (next.efforts = efforts)),
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
        { label: 'CLI の場所…', click: () => void showCliLocations() },
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
        { label: '対話モードを切り替える', accelerator: 'Shift+CmdOrCtrl+D', click: () => sendMenuCommand('toggle-dialogue') },
        { label: '返事を止める', accelerator: 'CmdOrCtrl+.', click: () => sendMenuCommand('stop') },
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
  ipcMain.handle('chat:dialogue', (event, id: unknown, on: unknown) => {
    if (typeof on !== 'boolean') throw new Error('対話モードの指定が不正です')
    fromMainWindow(event).setDialogue(parseConversationId(id), on)
  })
  ipcMain.handle('agents:choices', (event, id: unknown, agent: unknown) =>
    fromMainWindow(event).agentChoices(parseConversationId(id), parseAgentId(agent)),
  )
  ipcMain.handle('agents:effort', (event, id: unknown, agent: unknown, effort: unknown) => {
    fromMainWindow(event).setEffort(parseConversationId(id), parseAgentId(agent), parseEffort(effort))
  })
  ipcMain.handle('agents:model', (event, id: unknown, agent: unknown, model: unknown) => {
    fromMainWindow(event).setModel(parseConversationId(id), parseAgentId(agent), parseModel(model))
  })
}

if (!app.requestSingleInstanceLock()) {
  // Another AgentSync is already running with the same data; it gets focused instead.
  app.quit()
} else {
  app.on('second-instance', () => showWindow())

  void app.whenReady().then(async () => {
    // The page needs no browser permissions except copying to the clipboard.
    const allowed = (permission: string) => permission === 'clipboard-sanitized-write'
    session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => callback(allowed(permission)))
    session.defaultSession.setPermissionCheckHandler((_contents, permission) => allowed(permission))

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
