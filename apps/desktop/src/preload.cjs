const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('hotrod', {
  pickFolder: () => ipcRenderer.invoke('pick-folder'),
  onAddProject: (/** @type {() => void} */ listener) => {
    const handler = () => listener()
    ipcRenderer.on('add-project', handler)
    return () => ipcRenderer.removeListener('add-project', handler)
  },
})
