// Preload for the UI window (index.html): a narrow, safe API for the renderer.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('viewer', {
  // Clipboard text for Paste & Go.
  readClipboard: () => ipcRenderer.invoke('viewer:read-clipboard'),
  // Actions: 'fullscreen' | 'reload' | 'fit' | 'loop' | 'browse' | 'adblock' | 'new-window' | 'lock' | 'close'.
  action: (name) => ipcRenderer.send('viewer:action', name),
  // Layouts: read the list, apply one, replace the list (null = defaults).
  getLayouts: () => ipcRenderer.invoke('viewer:layouts'),
  applyLayout: (index) => ipcRenderer.send('viewer:layout-apply', index),
  saveLayouts: (list) => ipcRenderer.invoke('viewer:layouts-save', list),
  // The main process needs to know whether the URL bar is visible.
  setBarVisible: (visible) => ipcRenderer.send('viewer:bar-visible', visible),
  // Commands from the main process: 'toggle-bar' | 'toast' | 'open' | 'loop' | 'fullscreen' | 'locked'.
  onCommand: (callback) => {
    ipcRenderer.on('viewer:command', (_event, name, data) => callback(name, data));
  },
});
