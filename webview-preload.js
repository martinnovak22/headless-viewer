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

// Mouse side buttons (button 3 = back, 4 = forward) navigate the history like
// in a normal browser. Like Chrome, it fires on release; the press and the
// auxclick are swallowed so the page does not act on them as well.
const SIDE_BUTTONS = { 3: 'back', 4: 'forward' };
for (const type of ['mousedown', 'mouseup', 'auxclick']) {
  window.addEventListener(
    type,
    (event) => {
      const action = SIDE_BUTTONS[event.button];
      if (!event.isTrusted || !action) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (type === 'mouseup') ipcRenderer.send('viewer:action', action);
    },
    true
  );
}

// Two-finger horizontal swipe on a trackpad goes back / forward, like in a
// normal browser. A trackpad swipe arrives as horizontal wheel events; once the
// page cannot scroll any further sideways, the extra distance counts towards
// the gesture. Swiping left-to-right (scrolling towards the start) goes back.
const SWIPE_DISTANCE = 140; // px of horizontal over-scroll that triggers it
const SWIPE_IDLE_MS = 250; // a pause this long ends the gesture

let swipeDistance = 0;
let swipeFired = false;
let swipeTimer = null;

// Whether el or one of its ancestors can still scroll sideways in direction
// dir (-1 = left, 1 = right), so the page should get the scroll instead.
function canScrollX(el, dir) {
  const root = document.scrollingElement;
  for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
    if (node.scrollWidth <= node.clientWidth) continue;
    const overflow = getComputedStyle(node).overflowX;
    const scrollable =
      overflow === 'auto' || overflow === 'scroll' || (node === root && overflow !== 'hidden');
    if (!scrollable) continue;
    const left = Math.abs(node.scrollLeft); // negative in right-to-left pages
    if (dir < 0 ? left > 0 : left + node.clientWidth < node.scrollWidth - 1) return true;
  }
  return false;
}

// Bubble phase, so a page that uses horizontal swipes itself (a carousel, a
// map) and cancels the event keeps them.
window.addEventListener(
  'wheel',
  (event) => {
    if (!event.isTrusted || event.ctrlKey) return; // Ctrl+wheel / pinch = zoom
    clearTimeout(swipeTimer);
    swipeTimer = setTimeout(() => {
      swipeDistance = 0;
      swipeFired = false;
    }, SWIPE_IDLE_MS);
    if (swipeFired) return; // the rest of this gesture, incl. its momentum

    const dx = event.deltaMode === 1 ? event.deltaX * 16 : event.deltaX;
    const mostlySideways = Math.abs(dx) > Math.abs(event.deltaY) * 1.5;
    if (event.defaultPrevented || !mostlySideways || canScrollX(event.target, Math.sign(dx))) {
      swipeDistance = 0;
      return;
    }
    // A change of direction starts counting again.
    if (Math.sign(dx) !== Math.sign(swipeDistance)) swipeDistance = 0;
    swipeDistance += dx;
    if (Math.abs(swipeDistance) >= SWIPE_DISTANCE) {
      swipeFired = true;
      ipcRenderer.send('viewer:action', swipeDistance < 0 ? 'swipe-back' : 'swipe-forward');
    }
  },
  { passive: true }
);
