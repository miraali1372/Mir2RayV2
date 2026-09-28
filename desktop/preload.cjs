const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mir2rayDesktop', Object.freeze({
  platform: 'windows',
  invoke(method, options) {
    return ipcRenderer.invoke('mir2ray:invoke', method, options);
  },
}));
