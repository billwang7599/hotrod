const { contextBridge, ipcRenderer, webUtils } = require('electron')

contextBridge.exposeInMainWorld('kothar', {
  pickFolder: (/** @type {string | undefined} */ title) => ipcRenderer.invoke('pick-folder', title),
  pickFiles: (/** @type {string | undefined} */ title) => ipcRenderer.invoke('pick-files', title),
  // File.path is gone since Electron 32; a dropped file's real path comes from webUtils, here in the preload.
  pathForFile: (/** @type {File} */ file) => webUtils.getPathForFile(file),
  onNewChatFromFolder: (/** @type {() => void} */ listener) => {
    const handler = () => listener()
    ipcRenderer.on('new-chat-from-folder', handler)
    return () => ipcRenderer.removeListener('new-chat-from-folder', handler)
  },
  onQuitting: (/** @type {() => void} */ listener) => {
    const handler = () => listener()
    ipcRenderer.on('quitting', handler)
    return () => ipcRenderer.removeListener('quitting', handler)
  },
  forceQuit: () => ipcRenderer.invoke('force-quit'),
  vibrancy: process.platform === 'darwin',
  setAppearance: (/** @type {unknown} */ appearance) => ipcRenderer.send('set-appearance', appearance),
})
