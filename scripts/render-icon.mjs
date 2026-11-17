// Renders build/icon.svg to build/icon.png (1024 × 1024) with Electron's own Chromium.
// electron-builder turns the PNG into the macOS .icns. Usage: npm run icon
// (No top-level await here: in Electron's main process it would hold back the `ready` event.)
import { app, BrowserWindow } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SIZE = 1024

async function render() {
  const svg = readFileSync(path.join(root, 'build/icon.svg'), 'utf8')
  const window = new BrowserWindow({
    width: SIZE,
    height: SIZE,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: { offscreen: true, javascript: false },
  })
  const html = `<!doctype html><html><head><style>html,body{margin:0;overflow:hidden;background:transparent}svg{display:block}</style></head><body>${svg}</body></html>`
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
  await new Promise((resolve) => setTimeout(resolve, 500))
  let image = await window.webContents.capturePage()
  if (image.getSize().width !== SIZE) image = image.resize({ width: SIZE, height: SIZE, quality: 'best' })
  writeFileSync(path.join(root, 'build/icon.png'), image.toPNG())
  console.log(`build/icon.png ${JSON.stringify(image.getSize())}`)
}

setTimeout(() => {
  console.error('render-icon: timed out')
  app.exit(1)
}, 30_000).unref()

app.disableHardwareAcceleration()
app
  .whenReady()
  .then(render)
  .then(
    () => app.exit(0),
    (error) => {
      console.error(error)
      app.exit(1)
    },
  )
