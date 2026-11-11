// Preload okna s UI (index.html): úzké, bezpečné API pro renderer.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('viewer', {
  // Text ze schránky pro „Vložit a otevřít“.
  readClipboard: () => ipcRenderer.invoke('viewer:read-clipboard'),
  // Akce: 'fullscreen' | 'reload' | 'fit' | 'browse' | 'close'.
  action: (name) => ipcRenderer.send('viewer:action', name),
  // Hlavní proces potřebuje vědět, jestli je řádek pro URL vidět.
  setBarVisible: (visible) => ipcRenderer.send('viewer:bar-visible', visible),
  // Příkazy z hlavního procesu: 'toggle-bar' | 'toast' | 'fullscreen'.
  onCommand: (callback) => {
    ipcRenderer.on('viewer:command', (_event, name, data) => callback(name, data));
  },
});
