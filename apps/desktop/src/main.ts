import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startCore } from '@hotrod/core/main'

const uiDir = fileURLToPath(new URL('../../../packages/ui/dist', import.meta.url))
const preload = fileURLToPath(new URL('preload.cjs', import.meta.url))
const icon = fileURLToPath(new URL('../assets/icon.png', import.meta.url))
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

// Chromium's caches would otherwise land in the garage, which shares the app's name.
app.setPath('userData', join(app.getPath('appData'), 'Hotrod Desktop'))
start().catch((error: unknown) => {
  dialog.showErrorBox('Hotrod could not start', errorText(error))
  app.exit(1)
})

async function start() {
  await app.whenReady()
  if (process.platform === 'darwin') app.dock?.setIcon(icon)
  const hotrod = await startCore({ uiDir })

  const window = new BrowserWindow({
    width: 1200,
    height: 800,
    title: 'Hotrod',
    icon,
    webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: true },
  })

  let closing: Promise<void> | undefined
  let closed = false
  let confirming = false
  let forcing = false
  const forceQuit = () => {
    forcing = true
    void hotrod.close(true)
  }
  const confirmForceQuit = async () => {
    if (confirming || forcing || closed) return
    confirming = true
    const { response } = await dialog.showMessageBox(window, {
      type: 'warning',
      message: 'Force quit?',
      detail: 'Engines stop without finishing their turn. Any still running after a few seconds are killed.',
      buttons: ['Force Quit', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
    })
    confirming = false
    if (response === 0) forceQuit()
  }
  app.on('before-quit', (event) => {
    if (closed) return
    event.preventDefault()
    if (closing) return void confirmForceQuit()
    if (hotrod.core.chats().some((c) => c.status !== 'idle')) window.webContents.send('quitting')
    closing = hotrod.close().finally(() => {
      closed = true
      app.quit()
    })
  })
  window.on('close', (event) => {
    if (closed) return
    event.preventDefault()
    app.quit()
  })
  app.on('window-all-closed', () => app.quit())
  ipcMain.handle('force-quit', confirmForceQuit)
  const onSignal = () => {
    if (forcing) app.exit(1)
    else if (closing) forceQuit()
    else app.quit()
  }
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, onSignal)

  const pickFolder = async () => {
    const result = await dialog.showOpenDialog(window, {
      title: 'New chat from folder',
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
          {
            label: 'New chat from folder…',
            accelerator: 'CmdOrCtrl+O',
            click: () => window.webContents.send('new-chat-from-folder'),
          },
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
