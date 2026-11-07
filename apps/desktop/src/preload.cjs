const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('hotrod', {
  pickFolder: () => ipcRenderer.invoke('pick-folder'),
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
})
