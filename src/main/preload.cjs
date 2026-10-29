const { contextBridge, ipcRenderer } = require('electron');

const store = (method, ...args) => ipcRenderer.invoke('store', method, args).then((r) => {
  if (r && r.error) throw new Error(r.error);
  return r && r.result;
});

contextBridge.exposeInMainWorld('blobby', {
  store,
  captureRect: (rect) => ipcRenderer.invoke('capture-rect', rect),
  exportPage: (project, page) => ipcRenderer.invoke('export', project, page),
  addAsset: (project) => ipcRenderer.invoke('add-asset', project),
  reveal: (project) => ipcRenderer.invoke('reveal', project),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  claudeStatus: () => ipcRenderer.invoke('claude-status'),
  connectDesktop: () => ipcRenderer.invoke('connect-desktop'),
  connectCode: () => ipcRenderer.invoke('connect-code'),
  root: () => ipcRenderer.invoke('root'),
  appInfo: () => ipcRenderer.invoke('app-info'),
  revealRoot: () => ipcRenderer.invoke('reveal-root'),
  selectionChanged: (sel) => ipcRenderer.send('selection-changed', sel),
  on: (channel, fn) => {
    const allowed = ['store-changed', 'ai-activity', 'open-page', 'menu'];
    if (!allowed.includes(channel)) return () => {};
    const handler = (_e, payload) => fn(payload);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
});
