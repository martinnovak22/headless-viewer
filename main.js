// Main process: frameless window, keyboard shortcuts and tweaks to loaded pages.
const {
  app,
  BrowserWindow,
  Menu,
  clipboard,
  globalShortcut,
  ipcMain,
  screen,
  session,
  shell,
  webFrameMain,
} = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const isMac = process.platform === 'darwin';

// Media should start playing right after load, without a click.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// One entry per open viewer window. Each window keeps its own state:
//   win                 the BrowserWindow (index.html)
//   guest               webContents of the <webview> holding the loaded page
//   guestHtmlFullscreen the page itself put a <video> into fullscreen
//   fit                 'contain' = Fit, 'cover' = Fill
//   mediaMode           false = browse mode: the page is left untouched (signing in etc.)
//   urlBarVisible       whether the URL bar is showing
const viewers = new Set();

// Finds the viewer a webContents belongs to, as either its UI or its loaded page.
function viewerOf(contents) {
  for (const v of viewers) {
    if (v.win.webContents === contents || v.guest === contents) return v;
  }
  return null;
}

// Sites often refuse sign-in from an "unknown" browser, so present as regular Chrome.
app.userAgentFallback = app.userAgentFallback
  .replace(/\s(Electron|headless-viewer|HeadlessViewer)\/\S+/gi, '');

// ---------------------------------------------------------------------------
// CSS and JS injected into every loaded page
// ---------------------------------------------------------------------------

// Every rule is scoped to media mode, so browse mode only has to flip the
// data-hv-mode attribute. data-hv-root marks the documents whose own <html> and
// <body> get reset: always the top page, and an embedded frame only while it
// holds the main media. The page is locked (no scrolling, no margins) only
// when it actually has main media; any other page keeps scrolling normally.
const INJECTED_CSS = `
  html[data-hv-mode="media"][data-hv-root]:has([data-hv-main]),
  html[data-hv-mode="media"][data-hv-root]:has([data-hv-main]) > body {
    margin: 0 !important;
    padding: 0 !important;
    overflow: hidden !important;
    background: #000 !important;
    width: 100vw !important;
    height: 100vh !important;
  }
  html[data-hv-mode="media"][data-hv-root]:has([data-hv-main])::-webkit-scrollbar,
  html[data-hv-mode="media"][data-hv-root]:has([data-hv-main]) ::-webkit-scrollbar {
    display: none !important;
  }
  html[data-hv-mode="media"] [data-hv-main] {
    width: 100vw !important;
    height: 100vh !important;
    max-width: none !important;
    max-height: none !important;
    min-width: 0 !important;
    min-height: 0 !important;
    margin: 0 !important;
    padding: 0 !important;
    border: 0 !important;
    object-fit: contain !important;
    position: fixed !important;
    top: 0 !important;
    left: 0 !important;
    transform: none !important;
    z-index: 2147483647 !important;
    background: #000 !important;
  }
  html[data-hv-mode="media"][data-hv-fit="cover"] [data-hv-main] {
    object-fit: cover !important;
  }
`;

// Runs inside every frame of a loaded page (it is serialized with toString(),
// so it must not reference anything outside its own body).
//
// It finds the frame's main media element and marks it with data-hv-main:
//   1. a direct link to a file            -> its <video> / <img>
//   2. a visible <video> in this document -> the largest one
//   3. an embedded frame that reports a video of its own (cross-origin players)
//   4. the only <img> on the page (top page only)
// If nothing matches, the page is simply left as it is. The script is
// idempotent, so it can run again on every load event.
function frameScript(opts) {
  const root = document.documentElement;
  if (!root) return;
  if (window.__hv) {
    window.__hv.set(opts.fit, opts.mode);
    return;
  }

  const isTop = window === window.top;
  const MIN_FRAME_VIDEO_AREA = 40000; // ignore thumbnail-sized videos inside frames
  const MAX_CONTROL_FIXES = 20; // stop fighting a page that keeps removing controls
  const frameAreas = new Map(); // <iframe> -> area of the video it reported
  let ownArea = 0; // area of this frame's media, as reported to the parent
  let controlFixes = 0;

  const area = (el) => {
    const r = el.getBoundingClientRect();
    return r.width * r.height;
  };
  const inMediaMode = () => root.getAttribute('data-hv-mode') === 'media';

  // insertCSS only reaches the top document; frames get the same rules through
  // a constructed stylesheet, which a page's CSP cannot block.
  if (isTop) {
    root.setAttribute('data-hv-root', '');
  } else {
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(opts.css);
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    } catch {
      // Without the stylesheet the frame just keeps its normal layout.
    }
  }

  // The stretched video covers the site's own player UI, so make sure the
  // browser's native controls are there instead. Undone in browse mode.
  const syncControls = () => {
    const media = inMediaMode();
    for (const video of document.querySelectorAll('video[data-hv-controls]')) {
      if (!media || !video.hasAttribute('data-hv-main')) {
        video.controls = false;
        video.removeAttribute('data-hv-controls');
      }
    }
    const main = document.querySelector('video[data-hv-main]');
    if (media && main && !main.controls && controlFixes < MAX_CONTROL_FIXES) {
      controlFixes += 1;
      main.controls = true;
      main.setAttribute('data-hv-controls', '');
    }
  };

  // Tells the parent document that this frame holds media worth stretching.
  const report = () => {
    if (isTop) return;
    if (document.querySelector('[data-hv-main]')) {
      window.parent.postMessage({ __hv: 'media', area: ownArea }, '*');
    }
  };

  const setMain = (el) => {
    const current = document.querySelector('[data-hv-main]');
    if (current !== el) {
      if (current) current.removeAttribute('data-hv-main');
      if (el) {
        ownArea = el.tagName === 'IFRAME' ? frameAreas.get(el) || 0 : area(el);
        el.setAttribute('data-hv-main', '');
      }
    }
    if (!isTop) root.toggleAttribute('data-hv-root', Boolean(el));
    syncControls();
    report();
  };

  const pick = () => {
    const current = document.querySelector('[data-hv-main]');
    // A video that was already chosen stays; anything weaker can be upgraded.
    if (current && current.tagName === 'VIDEO') {
      setMain(current);
      return;
    }

    let target = null;
    if (/^(image|video|audio)\//.test(document.contentType || '')) {
      // Direct link to a file – Chromium wraps it in a simple document.
      target = document.querySelector('video, img');
    } else {
      const videos = [...document.querySelectorAll('video')];
      const visible = videos.filter((v) => area(v) > (isTop ? 0 : MIN_FRAME_VIDEO_AREA));
      if (visible.length) {
        target = visible.reduce((a, b) => (area(b) > area(a) ? b : a));
      } else {
        let bestArea = 0;
        for (const [frame, frameArea] of frameAreas) {
          if (!frame.isConnected) frameAreas.delete(frame);
          else if (frameArea > bestArea) [target, bestArea] = [frame, frameArea];
        }
        if (!target && isTop) {
          if (videos.length === 1) {
            target = videos[0];
          } else {
            const imgs = document.querySelectorAll('img');
            if (imgs.length === 1) target = imgs[0];
          }
        }
      }
    }
    setMain(target);
  };

  window.addEventListener('message', (event) => {
    const data = event.data;
    if (!data || typeof data !== 'object') return;
    if (data.__hv === 'ping' && event.source === window.parent) {
      report();
    } else if (data.__hv === 'media') {
      const frame = [...document.querySelectorAll('iframe')].find(
        (f) => f.contentWindow === event.source
      );
      if (!frame) return;
      if (!frameAreas.has(frame)) frameAreas.set(frame, Number(data.area) || 0);
      pick();
    }
  });

  window.__hv = {
    set(fit, mode) {
      root.setAttribute('data-hv-fit', fit);
      root.setAttribute('data-hv-mode', mode);
      pick();
    },
  };
  window.__hv.set(opts.fit, opts.mode);

  // Frames that loaded before this document was ready get asked again.
  for (const frame of document.querySelectorAll('iframe')) {
    try {
      frame.contentWindow.postMessage({ __hv: 'ping' }, '*');
    } catch {
      // Frame is not ready; it will report on its own once it loads.
    }
  }

  // Players often insert their <video> later, or strip its controls.
  let timer = null;
  new MutationObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(pick, 250);
  }).observe(root, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['controls'],
  });
}

// Runs inside a frame to act on its main video. Returns a short status text
// for the toast, or null when this frame has no main video.
function mediaCommand(name) {
  const video = document.querySelector('video[data-hv-main]');
  if (!video) return null;
  const volumeText = () => `Volume ${Math.round(video.volume * 100)}%`;
  switch (name) {
    case 'toggle':
      if (video.paused) video.play().catch(() => {});
      else video.pause();
      return '';
    case 'back':
      video.currentTime = Math.max(0, video.currentTime - 5);
      return '';
    case 'forward':
      video.currentTime = Math.min(video.duration || Infinity, video.currentTime + 5);
      return '';
    case 'volume-up':
      video.muted = false;
      video.volume = Math.min(1, Math.round((video.volume + 0.1) * 10) / 10);
      return volumeText();
    case 'volume-down':
      video.volume = Math.max(0, Math.round((video.volume - 0.1) * 10) / 10);
      return volumeText();
    case 'mute':
      video.muted = !video.muted;
      return video.muted ? 'Muted' : 'Unmuted';
    default:
      return null;
  }
}

function framesOf(contents) {
  try {
    return contents.isDestroyed() ? [] : contents.mainFrame.framesInSubtree;
  } catch {
    return []; // the page is being torn down
  }
}

// Runs code in every frame of the loaded page; resolves to the per-frame
// results (null for frames where it failed).
function runInFrames(v, code, userGesture = false) {
  if (!hasGuest(v)) return Promise.resolve([]);
  return Promise.all(
    framesOf(v.guest).map((frame) => frame.executeJavaScript(code, userGesture).catch(() => null))
  );
}

function frameCode(v) {
  const opts = { fit: v.fit, mode: v.mediaMode ? 'media' : 'browse', css: INJECTED_CSS };
  return `(${frameScript.toString()})(${JSON.stringify(opts)})`;
}

function injectFrame(v, frame) {
  if (frame) frame.executeJavaScript(frameCode(v)).catch(() => {});
}

function injectAll(v, contents, newDocument) {
  if (contents.isDestroyed()) return;
  if (newDocument) contents.insertCSS(INJECTED_CSS).catch(() => {});
  for (const frame of framesOf(contents)) injectFrame(v, frame);
}

// Pushes the current fit / mode to every frame that already runs the script.
function syncFrames(v) {
  const fit = JSON.stringify(v.fit);
  const mode = JSON.stringify(v.mediaMode ? 'media' : 'browse');
  runInFrames(v, `window.__hv && window.__hv.set(${fit}, ${mode})`);
}

// ---------------------------------------------------------------------------
// Ad blocking
// ---------------------------------------------------------------------------

// Best effort: if the library or its filter lists cannot be loaded (offline,
// CDN down), the viewer simply runs without blocking.
const PARTITION = 'persist:viewer';
let blocker = null; // ElectronBlocker once the filter lists are loaded
let settings = { adblock: true, layouts: null };

const settingsPath = () => path.join(app.getPath('userData'), 'settings.json');

function loadSettings() {
  try {
    settings = { ...settings, ...JSON.parse(fs.readFileSync(settingsPath(), 'utf8')) };
  } catch {
    // First run or unreadable file: keep the defaults.
  }
}

function saveSettings() {
  fs.promises.writeFile(settingsPath(), JSON.stringify(settings, null, 2)).catch(() => {});
}

function applyAdblock() {
  if (!blocker) return;
  const viewerSession = session.fromPartition(PARTITION);
  const enabled = blocker.isBlockingEnabled(viewerSession);
  if (settings.adblock && !enabled) blocker.enableBlockingInSession(viewerSession);
  else if (!settings.adblock && enabled) blocker.disableBlockingInSession(viewerSession);
}

async function initAdblock() {
  try {
    const { ElectronBlocker } = require('@ghostery/adblocker-electron');
    // The compiled filter engine is cached on disk, so later starts work offline.
    blocker = await ElectronBlocker.fromPrebuiltAdsOnly(fetch, {
      path: path.join(app.getPath('userData'), 'adblock-engine.bin'),
      read: fs.promises.readFile,
      write: fs.promises.writeFile,
    });
    applyAdblock();
  } catch (error) {
    blocker = null;
    console.warn(`Ad blocking is unavailable: ${error.message}`);
  }
}

function toggleAdblock(v) {
  if (!blocker) {
    sendCommand(v, 'toast', 'Ad blocking unavailable');
    return;
  }
  settings.adblock = !settings.adblock;
  saveSettings();
  applyAdblock();
  sendCommand(v, 'toast', settings.adblock ? 'Ad blocking on' : 'Ad blocking off');
  reload(v); // the change only shows on a fresh load
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function hasGuest(v) {
  return v.guest && !v.guest.isDestroyed();
}

function sendCommand(v, name, data) {
  if (!v.win.isDestroyed()) v.win.webContents.send('viewer:command', name, data);
}

function toggleFullscreen(v) {
  v.win.setFullScreen(!v.win.isFullScreen());
}

function reload(v) {
  if (hasGuest(v)) v.guest.reload();
}

function goBack(v) {
  if (hasGuest(v) && v.guest.navigationHistory.canGoBack()) v.guest.navigationHistory.goBack();
}

function goForward(v) {
  if (hasGuest(v) && v.guest.navigationHistory.canGoForward()) {
    v.guest.navigationHistory.goForward();
  }
}

// The momentum of a trackpad swipe keeps sending wheel events after the
// navigation, into the newly loaded page, whose preload starts counting anew.
// One swipe must not go back twice, so swipes are ignored for a moment.
const SWIPE_COOLDOWN_MS = 1000;
function swipe(v, navigate) {
  const now = Date.now();
  if (now - (v.lastSwipe || 0) < SWIPE_COOLDOWN_MS) return;
  v.lastSwipe = now;
  navigate(v);
}

function toggleFit(v) {
  v.fit = v.fit === 'contain' ? 'cover' : 'contain';
  syncFrames(v);
  sendCommand(v, 'toast', v.fit === 'cover' ? 'Fill' : 'Fit');
}

// Browse mode turns the page tweaks off so the page can be used normally
// (signing in, searching, scrolling). Media mode turns them back on.
function toggleMediaMode(v) {
  v.mediaMode = !v.mediaMode;
  syncFrames(v);
  sendCommand(v, 'toast', v.mediaMode ? 'Media mode' : 'Browse mode');
}

// Playback shortcuts act on the main video directly, so they work even when
// the site's own player UI is covered or the video sits in an embedded frame.
const MEDIA_COMMANDS = new Set(['toggle', 'back', 'forward', 'volume-up', 'volume-down', 'mute']);

async function runMediaCommand(v, name) {
  const code = `(${mediaCommand.toString()})(${JSON.stringify(name)})`;
  const results = await runInFrames(v, code, true);
  const text = results.find((result) => typeof result === 'string' && result);
  if (text) sendCommand(v, 'toast', text);
}

// ---- Stash: hide everything at once and bring it back --------------------
//
// One shortcut pauses whatever is playing and minimizes every viewer window;
// pressing it again restores the windows and resumes exactly what was playing.
// Restoring any single window by hand (Dock, taskbar) brings back the rest too.
const STASH_SHORTCUT = 'CommandOrControl+Shift+H';
let stashed = false;

// These run inside the page's frames (serialized with toString()).
function pausePlayingMedia() {
  for (const media of document.querySelectorAll('video, audio')) {
    if (!media.paused) {
      media.pause();
      media.setAttribute('data-hv-resume', '');
    }
  }
}

function resumePausedMedia() {
  for (const media of document.querySelectorAll('[data-hv-resume]')) {
    media.removeAttribute('data-hv-resume');
    media.play().catch(() => {});
  }
}

function stashAll() {
  stashed = true;
  for (const v of viewers) {
    runInFrames(v, `(${pausePlayingMedia.toString()})()`);
    if (v.win.isMinimized()) continue;
    if (isMac && v.win.isFullScreen()) {
      // macOS cannot minimize a fullscreen window: leave fullscreen first and
      // remember to return to it.
      v.restoreFullscreen = true;
      v.win.once('leave-full-screen', () => {
        if (stashed && !v.win.isDestroyed()) v.win.minimize();
      });
      v.win.setFullScreen(false);
    } else {
      v.win.minimize();
    }
  }
}

function unstashAll() {
  stashed = false;
  for (const v of viewers) {
    if (v.win.isMinimized()) v.win.restore();
    else v.win.show();
    if (v.restoreFullscreen) {
      v.restoreFullscreen = false;
      v.win.setFullScreen(true);
    }
    runInFrames(v, `(${resumePausedMedia.toString()})()`, true);
  }
}

function toggleStash() {
  if (viewers.size === 0) return;
  const anyVisible = [...viewers].some((v) => !v.win.isMinimized());
  if (anyVisible && !stashed) stashAll();
  else unstashAll();
}

// Opens another viewer window, slightly offset from the one it was opened from.
// url (optional) is loaded into the new window as soon as its UI is ready.
function openNewWindow(v, url) {
  const [x, y] = v.win.getPosition();
  const [width, height] = v.win.isFullScreen() ? [1280, 720] : v.win.getSize();
  const created = createWindow({ x: x + 32, y: y + 32, width, height });
  if (typeof url === 'string') created.pendingUrl = url;
}

// ---- Context menu on the loaded page --------------------------------------
//
// Three sections: Open (in a new viewer window or the default browser), Copy
// (every address under the cursor) and Inspect. Only items that
// apply to what was right-clicked are shown.

const isWebUrl = (url) => /^https?:/i.test(url || '');
// A new viewer window can also show an inline image; blob: URLs only live in
// the page that created them, so they are never offered.
const isViewerUrl = (url) => isWebUrl(url) || /^data:image\//i.test(url || '');

function showContextMenu(v, contents, params) {
  const media = { image: 'image', video: 'video', audio: 'audio' }[params.mediaType];
  // The things under the cursor, most specific first. The frame is offered
  // only for embedded frames, e.g. a player on someone else's page.
  const targets = [];
  if (params.linkURL) targets.push({ name: 'link', url: params.linkURL });
  if (media && params.srcURL) targets.push({ name: media, url: params.srcURL });
  if (params.frameURL && params.frameURL !== params.pageURL) {
    targets.push({ name: 'frame', url: params.frameURL });
  }
  targets.push({ name: 'page', url: params.pageURL });

  const open = [];
  for (const t of targets) {
    if (isViewerUrl(t.url)) {
      open.push({ label: `Open ${t.name} in new window`, click: () => openNewWindow(v, t.url) });
    }
    if (isWebUrl(t.url)) {
      open.push({ label: `Open ${t.name} in browser`, click: () => shell.openExternal(t.url) });
    }
  }

  const copy = [];
  if (params.isEditable) {
    const f = params.editFlags;
    copy.push(
      { label: 'Cut', role: 'cut', enabled: f.canCut },
      { label: 'Copy', role: 'copy', enabled: f.canCopy },
      { label: 'Paste', role: 'paste', enabled: f.canPaste },
      { label: 'Select all', role: 'selectAll', enabled: f.canSelectAll }
    );
  } else if (params.selectionText) {
    copy.push({ label: 'Copy text', click: () => clipboard.writeText(params.selectionText) });
  }
  if (params.linkText && params.linkText !== params.linkURL && !params.selectionText) {
    copy.push({ label: 'Copy link text', click: () => clipboard.writeText(params.linkText) });
  }
  for (const t of targets) {
    if (/^blob:/i.test(t.url) || !t.url) continue;
    copy.push({ label: `Copy ${t.name} address`, click: () => clipboard.writeText(t.url) });
  }

  const inspect = [
    { label: 'Inspect element', click: () => contents.inspectElement(params.x, params.y) },
  ];

  const template = [open, copy, inspect]
    .filter((section) => section.length)
    .flatMap((section, i) => (i ? [{ type: 'separator' }, ...section] : section));
  Menu.buildFromTemplate(template).popup({ window: v.win });
}


// ---- Layouts: arrange all windows into the zones of a preset --------------
//
// A layout divides the work area of one display into a grid of cols x rows
// cells. Each zone is [col, row, width, height] in cells. Zone 0 gets the
// window the layout was applied from; the rest fill in the remaining zones.
// Empty zones get new windows, extra windows are left where they are.
const DEFAULT_LAYOUTS = [
  {
    name: 'Center + corners',
    cols: 4,
    rows: 2,
    zones: [[1, 0, 2, 2], [0, 0, 1, 1], [3, 0, 1, 1], [0, 1, 1, 1], [3, 1, 1, 1]],
  },
  { name: 'Halves', cols: 2, rows: 1, zones: [[0, 0, 1, 1], [1, 0, 1, 1]] },
  { name: 'Thirds', cols: 3, rows: 1, zones: [[0, 0, 1, 1], [1, 0, 1, 1], [2, 0, 1, 1]] },
  { name: 'Grid', cols: 2, rows: 2, zones: [[0, 0, 1, 1], [1, 0, 1, 1], [0, 1, 1, 1], [1, 1, 1, 1]] },
  { name: 'Main + side', cols: 3, rows: 2, zones: [[0, 0, 2, 2], [2, 0, 1, 1], [2, 1, 1, 1]] },
];
const MAX_GRID = 8;
const MAX_ZONES = 12;
const MAX_LAYOUTS = 9; // one per shortcut, Ctrl+Alt+1 to 9

function layouts() {
  return Array.isArray(settings.layouts) ? settings.layouts : DEFAULT_LAYOUTS;
}

// Layouts arrive from the UI window, so check them before they are stored.
function validLayout(layout) {
  if (!layout || typeof layout !== 'object') return null;
  const { cols, rows, zones } = layout;
  const inRange = (n, min, max) => Number.isInteger(n) && n >= min && n <= max;
  if (!inRange(cols, 1, MAX_GRID) || !inRange(rows, 1, MAX_GRID)) return null;
  if (!Array.isArray(zones) || zones.length < 1 || zones.length > MAX_ZONES) return null;
  const used = new Set();
  for (const zone of zones) {
    if (!Array.isArray(zone) || zone.length !== 4) return null;
    const [x, y, w, h] = zone;
    if (!inRange(x, 0, cols - 1) || !inRange(y, 0, rows - 1)) return null;
    if (!inRange(w, 1, cols - x) || !inRange(h, 1, rows - y)) return null;
    for (let c = x; c < x + w; c++) {
      for (let r = y; r < y + h; r++) {
        if (used.has(`${c},${r}`)) return null; // zones must not overlap
        used.add(`${c},${r}`);
      }
    }
  }
  const name = String(layout.name || '').trim().slice(0, 40) || `${cols} × ${rows}`;
  return { name, cols, rows, zones: zones.map((zone) => [...zone]) };
}

function layoutState() {
  return {
    layouts: layouts(),
    isDefault: !Array.isArray(settings.layouts),
    max: MAX_LAYOUTS,
    maxGrid: MAX_GRID,
    maxZones: MAX_ZONES,
  };
}

// Pixel rectangles of the zones inside a display's work area. Neighbouring
// zones share their edge exactly, with no gap and no overlap.
function zoneRects(layout, area) {
  const colX = (c) => area.x + Math.round((area.width * c) / layout.cols);
  const rowY = (r) => area.y + Math.round((area.height * r) / layout.rows);
  return layout.zones.map(([c, r, w, h]) => ({
    x: colX(c),
    y: rowY(r),
    width: colX(c + w) - colX(c),
    height: rowY(r + h) - rowY(r),
  }));
}

// Locking only stops the user from moving and resizing; fullscreen,
// minimizing and stashing keep working.
function setLocked(v, locked) {
  v.locked = locked;
  v.win.setMovable(!locked);
  v.win.setResizable(!locked);
  v.win.setFullScreenable(true);
  sendCommand(v, 'locked', locked);
}

function placeWindow(v, rect) {
  const win = v.win;
  v.restoreFullscreen = false;
  const apply = () => {
    if (win.isDestroyed()) return;
    // Programmatic moves are allowed on a locked window, but some platforms
    // refuse to resize one, so unlock just for the move.
    const locked = v.locked;
    if (locked) setLocked(v, false);
    win.setBounds(rect);
    if (locked) setLocked(v, true);
  };
  if (win.isFullScreen()) {
    // Leaving fullscreen animates and then restores the old frame; move after that.
    win.once('leave-full-screen', () => setTimeout(apply, isMac ? 50 : 0));
    win.setFullScreen(false);
    return;
  }
  if (win.isMinimized()) win.restore();
  if (win.isMaximized()) win.unmaximize();
  apply();
}

function applyLayout(origin, index) {
  const layout = layouts()[index];
  if (!layout) return;
  if (stashed) unstashAll();
  const area = screen.getDisplayMatching(origin.win.getBounds()).workArea;
  const rects = zoneRects(layout, area);

  // The window the layout was applied from goes first. The others keep the
  // order of their zones from the previous layout, so applying a layout again
  // does not shuffle them; windows without a zone follow in opening order.
  const rest = [...viewers].filter((v) => v !== origin);
  rest.sort((a, b) => (a.zone ?? Infinity) - (b.zone ?? Infinity));
  const ordered = [origin, ...rest];

  ordered.forEach((v, i) => {
    v.zone = i < rects.length ? i : null;
    if (i < rects.length) placeWindow(v, rects[i]);
  });
  for (let i = ordered.length; i < rects.length; i++) {
    const v = createWindow(rects[i]);
    v.zone = i;
    if (origin.locked) setLocked(v, true);
  }
  sendCommand(origin, 'toast', layout.name);
}

function toggleLock(origin) {
  const lock = ![...viewers].some((v) => v.locked);
  for (const v of viewers) setLocked(v, lock);
  sendCommand(origin, 'toast', lock ? 'Layout locked' : 'Layout unlocked');
}

const ACTIONS = {
  fullscreen: toggleFullscreen,
  reload,
  back: goBack,
  forward: goForward,
  'swipe-back': (v) => swipe(v, goBack),
  'swipe-forward': (v) => swipe(v, goForward),
  fit: toggleFit,
  browse: toggleMediaMode,
  adblock: toggleAdblock,
  'new-window': openNewWindow,
  lock: toggleLock,
  close: (v) => v.win.close(),
};

// Shortcuts with modifiers and function keys. They are caught in the main
// process so they behave the same whether the home screen or the loaded page
// has focus. Bare letters (F, R, C, B) are handled by the renderer and
// webview-preload, because they need to know whether the user is typing in a
// text field.
function handleInput(v, contents, event, input) {
  if (input.type !== 'keyDown') return;
  const key = input.key.toLowerCase();
  const mod = input.control || input.meta; // Ctrl (Windows/Linux) or Cmd (macOS)
  // Alt+arrow inside the URL bar should move the caret, not the history.
  const editingUrl = v.urlBarVisible && contents === v.win.webContents;

  // Ctrl+Alt+1 to 9 and Ctrl+Alt+L. Matched by physical key, because Alt
  // (Option on macOS) changes the typed character. On Windows Ctrl+Alt is
  // also AltGr, so leave it to the URL field while the user types there.
  const layoutKey = mod && input.alt && !input.shift && (isMac || !editingUrl);
  const layoutDigit = /^Digit[1-9]$/.test(input.code) ? Number(input.code.slice(5)) : 0;

  let handler = null;
  if (layoutKey && layoutDigit) handler = () => applyLayout(v, layoutDigit - 1);
  else if (layoutKey && input.code === 'KeyL') handler = () => toggleLock(v);
  else if (mod && !input.alt && !input.shift && key === 'l') handler = () => sendCommand(v, 'toggle-bar');
  else if (key === 'escape' && !v.guestHtmlFullscreen) handler = () => sendCommand(v, 'toggle-bar');
  else if (key === 'f11') handler = () => toggleFullscreen(v);
  else if (mod && !input.alt && key === 'r') handler = () => reload(v);
  else if (mod && !input.alt && key === 'b') handler = () => toggleMediaMode(v);
  else if (mod && !input.alt && key === 'n') handler = () => openNewWindow(v);
  else if (mod && !input.alt && key === 'q') handler = () => app.quit();
  // Normally the global shortcut gets this first; this is the fallback for
  // when another program already owns the combination.
  else if (mod && input.shift && !input.alt && key === 'h') handler = toggleStash;
  else if (input.alt && key === 'arrowleft' && !editingUrl) handler = () => goBack(v);
  else if (input.alt && key === 'arrowright' && !editingUrl) handler = () => goForward(v);
  // Cmd+[ and Cmd+] as in Safari and Chrome on macOS; mouse utilities such as
  // Logi Options often map the side buttons to exactly these.
  else if (isMac && input.meta && !input.alt && input.code === 'BracketLeft') handler = () => goBack(v);
  else if (isMac && input.meta && !input.alt && input.code === 'BracketRight') handler = () => goForward(v);

  if (handler) {
    event.preventDefault();
    handler();
  }
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

function setupGuest(v, contents) {
  v.guest = contents;
  v.guestHtmlFullscreen = false;

  contents.on('dom-ready', () => injectAll(v, contents, true));
  contents.on('did-finish-load', () => injectAll(v, contents, false));
  // Embedded players live in their own frames, which load on their own schedule.
  contents.on('did-frame-finish-load', (_event, isMainFrame, processId, routingId) => {
    if (!isMainFrame) injectFrame(v, webFrameMain.fromId(processId, routingId));
  });
  contents.on('before-input-event', (event, input) => handleInput(v, contents, event, input));
  contents.on('context-menu', (_event, params) => showContextMenu(v, contents, params));
  contents.on('enter-html-full-screen', () => (v.guestHtmlFullscreen = true));
  contents.on('leave-html-full-screen', () => (v.guestHtmlFullscreen = false));

  // No new windows – target=_blank links open in place.
  contents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) contents.loadURL(url).catch(() => {});
    return { action: 'deny' };
  });

  contents.on('destroyed', () => {
    if (v.guest === contents) v.guest = null;
  });
}

function createWindow(bounds = {}) {
  const win = new BrowserWindow({
    width: 1280,
    height: 720,
    ...bounds,
    minWidth: 320,
    minHeight: 200,
    frame: false,
    backgroundColor: '#0a0a0a',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: true,
    },
  });

  const v = {
    win,
    guest: null,
    guestHtmlFullscreen: false,
    fit: 'contain',
    mediaMode: true,
    restoreFullscreen: false,
    urlBarVisible: true,
    zone: null, // index of the zone in the last applied layout
    locked: false, // cannot be moved or resized by the user
    pendingUrl: null, // URL to load once the UI is ready (Open in new window)
  };
  viewers.add(v);

  win.once('ready-to-show', () => win.show());
  win.on('closed', () => viewers.delete(v));
  // Bringing one stashed window back by hand brings back all of them.
  win.on('restore', () => {
    if (stashed) unstashAll();
  });
  win.on('enter-full-screen', () => sendCommand(v, 'fullscreen', true));
  win.on('leave-full-screen', () => sendCommand(v, 'fullscreen', false));

  const host = win.webContents;
  // A window locked before its UI finished loading missed the command.
  host.on('did-finish-load', () => {
    if (v.locked) sendCommand(v, 'locked', true);
    if (v.pendingUrl) sendCommand(v, 'open', v.pendingUrl);
    v.pendingUrl = null;
  });
  host.on('before-input-event', (event, input) => handleInput(v, host, event, input));

  // The UI window must never navigate away or open other windows.
  host.on('will-navigate', (event) => event.preventDefault());
  host.setWindowOpenHandler(() => ({ action: 'deny' }));

  // The loaded page runs isolated, with only our small preload.
  host.on('will-attach-webview', (_event, webPreferences) => {
    webPreferences.preload = path.join(__dirname, 'webview-preload.js');
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
    // Shortcuts and double-click must also work while an embedded player has focus.
    webPreferences.nodeIntegrationInSubFrames = true;
    // Persistent storage: cookies and logins survive an app restart
    // and are shared by all viewer windows.
    webPreferences.partition = PARTITION;
  });
  host.on('did-attach-webview', (_event, contents) => setupGuest(v, contents));

  win.loadFile(path.join(__dirname, 'index.html'));
  return v;
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

// Only the UI window of a viewer, not the page loaded in it.
function hostViewerOf(event) {
  const v = viewerOf(event.sender);
  return v && v.win.webContents === event.sender ? v : null;
}

// Actions a loaded page may trigger; the rest are reserved for the UI window.
const GUEST_ACTIONS = new Set([
  'fullscreen',
  'reload',
  'back',
  'forward',
  'swipe-back',
  'swipe-forward',
  'fit',
  'browse',
  'adblock',
]);

ipcMain.on('viewer:action', (event, name) => {
  const v = viewerOf(event.sender);
  if (!v || !Object.hasOwn(ACTIONS, name)) return;
  if (event.sender === v.guest && !GUEST_ACTIONS.has(name)) return;
  ACTIONS[name](v);
});

ipcMain.on('viewer:media', (event, name) => {
  const v = viewerOf(event.sender);
  if (v && event.sender === v.guest && MEDIA_COMMANDS.has(name)) runMediaCommand(v, name);
});

ipcMain.on('viewer:bar-visible', (event, visible) => {
  const v = hostViewerOf(event);
  if (v) v.urlBarVisible = Boolean(visible);
});

ipcMain.handle('viewer:layouts', (event) => (hostViewerOf(event) ? layoutState() : null));

ipcMain.on('viewer:layout-apply', (event, index) => {
  const v = hostViewerOf(event);
  if (v && Number.isInteger(index)) applyLayout(v, index);
});

// Replaces the whole list (add, delete, reorder); null restores the defaults.
ipcMain.handle('viewer:layouts-save', (event, list) => {
  if (!hostViewerOf(event)) return null;
  if (list === null) {
    settings.layouts = null;
  } else {
    if (!Array.isArray(list) || list.length > MAX_LAYOUTS) return layoutState();
    const checked = list.map(validLayout);
    if (checked.some((layout) => !layout)) return layoutState();
    settings.layouts = checked;
  }
  saveSettings();
  return layoutState();
});

ipcMain.handle('viewer:read-clipboard', (event) => {
  return hostViewerOf(event) ? clipboard.readText() : '';
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

app.whenReady().then(() => {
  if (isMac) {
    // macOS needs a menu for Cmd+C/V/X/A in the text field and for Cmd+Q.
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        { role: 'appMenu' },
        { role: 'editMenu' },
      ])
    );
  } else {
    Menu.setApplicationMenu(null);
  }

  if (!globalShortcut.register(STASH_SHORTCUT, toggleStash)) {
    console.warn(`Could not register ${STASH_SHORTCUT}; it only works while the viewer has focus.`);
  }

  loadSettings();
  initAdblock(); // in the background; windows do not wait for it
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('will-quit', () => globalShortcut.unregisterAll());

app.on('window-all-closed', () => app.quit());
