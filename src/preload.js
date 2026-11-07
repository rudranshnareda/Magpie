const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('magpie', {
  invoke: (ch, ...a) => ipcRenderer.invoke(ch, ...a),
  send: (ch, ...a) => ipcRenderer.send(ch, ...a),
  on: (ch, f) => ipcRenderer.on(ch, (_, ...a) => f(...a)),
});
