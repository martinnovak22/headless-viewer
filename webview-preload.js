// Preload for the loaded page (<webview>): single-letter shortcuts and double-click.
// Runs isolated from the page's scripts and exposes no API to the page.
const { ipcRenderer } = require('electron');

function isEditable(target) {
  if (!target || !target.tagName) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

const KEY_ACTIONS = { f: 'fullscreen', r: 'reload', c: 'fit', b: 'browse' };

window.addEventListener(
  'keydown',
  (event) => {
    if (event.ctrlKey || event.metaKey || event.altKey || event.repeat) return;
    if (isEditable(event.target)) return;
    const action = KEY_ACTIONS[event.key.toLowerCase()];
    if (!action) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    ipcRenderer.send('viewer:action', action);
  },
  true
);

window.addEventListener(
  'dblclick',
  (event) => {
    if (isEditable(event.target)) return;
    // Stops <video> from also toggling its own element fullscreen.
    event.preventDefault();
    event.stopImmediatePropagation();
    ipcRenderer.send('viewer:action', 'fullscreen');
  },
  true
);
