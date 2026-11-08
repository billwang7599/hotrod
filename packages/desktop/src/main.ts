import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, shell } from 'electron'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startCore } from '@hotrod/core/main'

const uiDir = fileURLToPath(new URL('../../ui/dist', import.meta.url))
const preload = fileURLToPath(new URL('preload.cjs', import.meta.url))
const icon = fileURLToPath(new URL('../assets/icon.png', import.meta.url))
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))
const VIBRANCY = 'sidebar'

// Chromium's caches would otherwise land in the garage, which shares the app's name.
app.setPath('userData', join(app.getPath('appData'), 'Hotrod Desktop'))
if (!app.requestSingleInstanceLock()) app.quit()
else
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
    minWidth: 375,
    minHeight: 600,
    useContentSize: true,
    title: 'Hotrod',
    icon,
    show: false,
    // Only a window created with vibrancy gets a see-through compositor; adding it later paints over stale frames.
    vibrancy: VIBRANCY,
    visualEffectState: 'active',
    // Chromium's PDF viewer counts as a plugin, and attachment previews need it.
    webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: true, plugins: true },
  })
  window.once('ready-to-show', () => window.show())

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
  app.on('second-instance', () => {
    if (window.isMinimized()) window.restore()
    window.focus()
  })
  ipcMain.handle('force-quit', confirmForceQuit)
  const onSignal = () => {
    if (forcing) app.exit(1)
    else if (closing) forceQuit()
    else app.quit()
  }
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, onSignal)

  const pickFolder = async (title = 'New space from folder') => {
    const result = await dialog.showOpenDialog(window, { title, properties: ['openDirectory', 'createDirectory'] })
    return result.canceled ? null : (result.filePaths[0] ?? null)
  }
  ipcMain.handle('pick-folder', (_event, title?: string) => pickFolder(title))
  ipcMain.on('set-appearance', (_event, appearance: { scheme: string; vibrancy: boolean; background: string }) => {
    const { scheme, vibrancy, background } = appearance
    if (scheme === 'system' || scheme === 'light' || scheme === 'dark') nativeTheme.themeSource = scheme
    if (process.platform === 'darwin') window.setVibrancy(vibrancy ? VIBRANCY : null)
    window.setBackgroundColor(background)
  })

  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(process.platform === 'darwin' ? [{ role: 'appMenu' as const }] : []),
      {
        label: 'File',
        submenu: [
          {
            label: 'New space from folder…',
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
