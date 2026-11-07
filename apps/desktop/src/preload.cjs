const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('hotrod', { pickFolder: () => ipcRenderer.invoke('pick-folder') })
