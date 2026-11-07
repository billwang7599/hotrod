import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startCore } from '@hotrod/core/main'

const uiDir = fileURLToPath(new URL('../../../packages/ui/dist', import.meta.url))
const preload = fileURLToPath(new URL('preload.cjs', import.meta.url))
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

// Chromium's caches would otherwise land in the garage, which shares the app's name.
app.setPath('userData', join(app.getPath('appData'), 'Hotrod Desktop'))
start().catch((error: unknown) => {
  dialog.showErrorBox('Hotrod could not start', errorText(error))
  app.exit(1)
})

async function start() {
  await app.whenReady()
  const hotrod = await startCore({ uiDir })

  let closing: Promise<void> | undefined
  let closed = false
  app.on('will-quit', (event) => {
    if (closed) return
    event.preventDefault()
    closing ??= hotrod.close().finally(() => {
      closed = true
      app.quit()
    })
  })
  app.on('window-all-closed', () => app.quit())
  const onSignal = () => (closing ? process.exit(1) : app.quit())
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, onSignal)

  const window = new BrowserWindow({
    width: 1200,
    height: 800,
    title: 'Hotrod',
    webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: true },
  })

  const pickFolder = async () => {
    const result = await dialog.showOpenDialog(window, {
      title: 'Add Project',
      properties: ['openDirectory', 'createDirectory'],
    })
    return result.canceled ? null : (result.filePaths[0] ?? null)
  }
  ipcMain.handle('pick-folder', pickFolder)

  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(process.platform === 'darwin' ? [{ role: 'appMenu' as const }] : []),
      {
        label: 'File',
        submenu: [
          { label: 'Add Project…', accelerator: 'CmdOrCtrl+O', click: () => window.webContents.send('add-project') },
          { type: 'separator' },
          { role: process.platform === 'darwin' ? 'close' : 'quit' },
        ],
      },
      { role: 'editMenu' },
      { role: 'viewMenu' },
      { role: 'windowMenu' },
    ]),
  )

  const openOutside = (url: string) => {
    if (/^https?:/.test(url)) void shell.openExternal(url)
  }
  window.webContents.setWindowOpenHandler(({ url }) => {
    openOutside(url)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event, url) => {
    if (new URL(url).origin === hotrod.uiUrl) return
    event.preventDefault()
    openOutside(url)
  })
  await window.loadURL(hotrod.openUrl)
}
