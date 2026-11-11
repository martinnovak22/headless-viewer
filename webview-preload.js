// Preload for the loaded page (<webview>): single-letter shortcuts, playback
// keys and double-click. It runs in every frame of the page, isolated from the
// page's scripts, and exposes no API to the page.
const { ipcRenderer } = require('electron');

function isEditable(target) {
  if (!target || !target.tagName) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

const KEY_ACTIONS = { f: 'fullscreen', r: 'reload', c: 'fit', b: 'browse', a: 'adblock' };

// Playback keys, sent to the main process, which applies them to the main
// video in whichever frame it lives.
const MEDIA_KEYS = {
  ' ': 'toggle',
  k: 'toggle',
  arrowleft: 'back',
  arrowright: 'forward',
  arrowup: 'volume-up',
  arrowdown: 'volume-down',
  m: 'mute',
};

// Playback keys are taken over only in media mode and only when this frame
// shows the main video (directly or through an embedded frame). Otherwise the
// page keeps its normal keyboard behaviour.
function hasMainVideo() {
  const root = document.documentElement;
  if (!root || root.getAttribute('data-hv-mode') !== 'media') return false;
  return Boolean(document.querySelector('video[data-hv-main], iframe[data-hv-main]'));
}

window.addEventListener(
  'keydown',
  (event) => {
    // Ignore key events synthesized by page scripts.
    if (!event.isTrusted) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (isEditable(event.target)) return;
    const key = event.key.toLowerCase();

    const mediaCommand = MEDIA_KEYS[key];
    if (mediaCommand && hasMainVideo()) {
      event.preventDefault();
      event.stopImmediatePropagation();
      // Holding a key repeats seeking and volume, but not play/pause or mute.
      if (!event.repeat || key.startsWith('arrow')) ipcRenderer.send('viewer:media', mediaCommand);
      return;
    }

    const action = KEY_ACTIONS[key];
    if (!action || event.repeat) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    ipcRenderer.send('viewer:action', action);
  },
  true
);

// The native controls react to the same keys on keyup/keypress; swallow those
// too so a key press is never handled twice.
for (const type of ['keyup', 'keypress']) {
  window.addEventListener(
    type,
    (event) => {
      if (!event.isTrusted || event.ctrlKey || event.metaKey || event.altKey) return;
      if (isEditable(event.target)) return;
      if (MEDIA_KEYS[event.key.toLowerCase()] && hasMainVideo()) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    },
    true
  );
}

window.addEventListener(
  'dblclick',
  (event) => {
    if (!event.isTrusted || isEditable(event.target)) return;
    // Stops <video> from also toggling its own element fullscreen.
    event.preventDefault();
    event.stopImmediatePropagation();
    ipcRenderer.send('viewer:action', 'fullscreen');
  },
  true
);
