const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('hotrod', {
  pickFolder: (/** @type {string | undefined} */ title) => ipcRenderer.invoke('pick-folder', title),
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
