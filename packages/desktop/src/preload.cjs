const { contextBridge, ipcRenderer, webUtils } = require('electron')

contextBridge.exposeInMainWorld('kothar', {
  pickFolder: (/** @type {string | undefined} */ title) => ipcRenderer.invoke('pick-folder', title),
  pickFiles: (/** @type {string | undefined} */ title) => ipcRenderer.invoke('pick-files', title),
  // File.path is gone since Electron 32; a dropped file's real path comes from webUtils, here in the preload.
  pathForFile: (/** @type {File} */ file) => webUtils.getPathForFile(file),
  // A menu item ran a shortcut's action (by its id in the UI's shortcut registry).
  onShortcut: (/** @type {(action: string) => void} */ listener) => {
    const handler = (/** @type {unknown} */ _event, /** @type {string} */ action) => listener(action)
    ipcRenderer.on('shortcut', handler)
    return () => ipcRenderer.removeListener('shortcut', handler)
  },
  setMenuShortcuts: (/** @type {Record<string, string | null>} */ accelerators) =>
    ipcRenderer.send('set-menu-shortcuts', accelerators),
  onQuitting: (/** @type {() => void} */ listener) => {
    const handler = () => listener()
    ipcRenderer.on('quitting', handler)
    return () => ipcRenderer.removeListener('quitting', handler)
  },
  forceQuit: () => ipcRenderer.invoke('force-quit'),
  notify: (/** @type {{ title: string; body: string; open?: string }} */ shown) => ipcRenderer.send('notify', shown),
  // A notification was clicked: open its chat.
  onOpenChat: (/** @type {(chatId: string) => void} */ listener) => {
    const handler = (/** @type {unknown} */ _event, /** @type {string} */ chatId) => listener(chatId)
    ipcRenderer.on('open-chat', handler)
    return () => ipcRenderer.removeListener('open-chat', handler)
  },
  vibrancy: process.platform === 'darwin',
  setAppearance: (/** @type {unknown} */ appearance) => ipcRenderer.send('set-appearance', appearance),
})
