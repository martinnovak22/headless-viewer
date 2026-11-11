// Main process: frameless window, keyboard shortcuts and tweaks to loaded pages.
const { app, BrowserWindow, Menu, clipboard, ipcMain, session, webFrameMain } = require('electron');
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
// holds the main media.
const INJECTED_CSS = `
  html[data-hv-mode="media"][data-hv-root],
  html[data-hv-mode="media"][data-hv-root] > body {
    margin: 0 !important;
    padding: 0 !important;
    overflow: hidden !important;
    background: #000 !important;
    width: 100vw !important;
    height: 100vh !important;
  }
  html[data-hv-mode="media"][data-hv-root]::-webkit-scrollbar,
  html[data-hv-mode="media"][data-hv-root] ::-webkit-scrollbar {
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
let settings = { adblock: true };

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

// Opens another viewer window, slightly offset from the one it was opened from.
function openNewWindow(v) {
  const [x, y] = v.win.getPosition();
  const [width, height] = v.win.isFullScreen() ? [1280, 720] : v.win.getSize();
  createWindow({ x: x + 32, y: y + 32, width, height });
}

const ACTIONS = {
  fullscreen: toggleFullscreen,
  reload,
  fit: toggleFit,
  browse: toggleMediaMode,
  adblock: toggleAdblock,
  'new-window': openNewWindow,
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

  let handler = null;
  if (mod && !input.alt && key === 'l') handler = () => sendCommand(v, 'toggle-bar');
  else if (key === 'escape' && !v.guestHtmlFullscreen) handler = () => sendCommand(v, 'toggle-bar');
  else if (key === 'f11') handler = () => toggleFullscreen(v);
  else if (mod && !input.alt && key === 'r') handler = () => reload(v);
  else if (mod && !input.alt && key === 'b') handler = () => toggleMediaMode(v);
  else if (mod && !input.alt && key === 'n') handler = () => openNewWindow(v);
  else if (mod && !input.alt && key === 'q') handler = () => app.quit();
  else if (input.alt && key === 'arrowleft' && !editingUrl) handler = () => goBack(v);
  else if (input.alt && key === 'arrowright' && !editingUrl) handler = () => goForward(v);

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
    urlBarVisible: true,
  };
  viewers.add(v);

  win.once('ready-to-show', () => win.show());
  win.on('closed', () => viewers.delete(v));
  win.on('enter-full-screen', () => sendCommand(v, 'fullscreen', true));
  win.on('leave-full-screen', () => sendCommand(v, 'fullscreen', false));

  const host = win.webContents;
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
const GUEST_ACTIONS = new Set(['fullscreen', 'reload', 'fit', 'browse', 'adblock']);

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

  loadSettings();
  initAdblock(); // in the background; windows do not wait for it
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => app.quit());
