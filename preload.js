// Preload for the UI window (index.html): a narrow, safe API for the renderer.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('viewer', {
  // Clipboard text for Paste & Go.
  readClipboard: () => ipcRenderer.invoke('viewer:read-clipboard'),
  // Actions: 'fullscreen' | 'reload' | 'fit' | 'browse' | 'new-window' | 'close'.
  action: (name) => ipcRenderer.send('viewer:action', name),
  // The main process needs to know whether the URL bar is visible.
  setBarVisible: (visible) => ipcRenderer.send('viewer:bar-visible', visible),
  // Commands from the main process: 'toggle-bar' | 'toast' | 'fullscreen'.
  onCommand: (callback) => {
    ipcRenderer.on('viewer:command', (_event, name, data) => callback(name, data));
  },
});
