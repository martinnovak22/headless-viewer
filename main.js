// Main process: frameless window, keyboard shortcuts and tweaks to loaded pages.
const { app, BrowserWindow, Menu, clipboard, ipcMain } = require('electron');
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
//   cssKey              key of the CSS inserted into the current document
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

const INJECTED_CSS = `
  html, body {
    margin: 0 !important;
    padding: 0 !important;
    overflow: hidden !important;
    background: #000 !important;
    width: 100vw !important;
    height: 100vh !important;
  }
  ::-webkit-scrollbar { display: none !important; }
  [data-hv-main] {
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
  html[data-hv-fit="cover"] [data-hv-main] {
    object-fit: cover !important;
  }
`;

// Finds the page's main media element and marks it with data-hv-main.
// The script is idempotent, so it can run repeatedly (dom-ready and did-finish-load).
function injectedScript(fitMode) {
  return `(() => {
    const root = document.documentElement;
    if (!root) return;
    root.setAttribute('data-hv-fit', ${JSON.stringify(fitMode)});
    if (window.__hvPick) { window.__hvPick(); return; }

    const area = (el) => {
      const r = el.getBoundingClientRect();
      return r.width * r.height;
    };

    const pick = () => {
      const current = document.querySelector('[data-hv-main]');
      if (current && current.isConnected) return;

      let target = null;
      if (/^(image|video|audio)\\//.test(document.contentType || '')) {
        // Direct link to a file – Chromium wraps it in a simple document.
        target = document.querySelector('video, img');
      } else {
        // Regular page: the largest <video>, or the only <img> on the page.
        const videos = [...document.querySelectorAll('video')];
        if (videos.length) {
          target = videos.reduce((a, b) => (area(b) > area(a) ? b : a));
        } else {
          const imgs = document.querySelectorAll('img');
          if (imgs.length === 1) target = imgs[0];
        }
      }
      if (target) target.setAttribute('data-hv-main', '');
    };

    window.__hvPick = pick;
    pick();

    // Players often insert their <video> later.
    let timer = null;
    new MutationObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(pick, 250);
    }).observe(root, { childList: true, subtree: true });
  })();`;
}

async function applyCss(v, contents) {
  if (contents.isDestroyed()) return;
  try {
    const key = await contents.insertCSS(INJECTED_CSS);
    // The user may have switched to browse mode in the meantime.
    if (v.mediaMode && v.guest === contents) v.cssKey = key;
    else contents.removeInsertedCSS(key).catch(() => {});
  } catch {
    // The document is gone by now (new navigation).
  }
}

function injectInto(v, contents, newDocument) {
  if (contents.isDestroyed()) return;
  if (newDocument) {
    v.cssKey = null; // the previous document's CSS went away with it
    if (v.mediaMode) applyCss(v, contents);
  }
  contents.executeJavaScript(injectedScript(v.fit)).catch(() => {});
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
  if (hasGuest(v)) {
    v.guest
      .executeJavaScript(
        `document.documentElement.setAttribute('data-hv-fit', ${JSON.stringify(v.fit)})`
      )
      .catch(() => {});
  }
  sendCommand(v, 'toast', v.fit === 'cover' ? 'Fill' : 'Fit');
}

// Browse mode turns the page tweaks off so the page can be used normally
// (signing in, searching, scrolling). Media mode turns them back on.
function toggleMediaMode(v) {
  v.mediaMode = !v.mediaMode;
  if (hasGuest(v)) {
    if (v.mediaMode) {
      applyCss(v, v.guest);
    } else if (v.cssKey) {
      v.guest.removeInsertedCSS(v.cssKey).catch(() => {});
      v.cssKey = null;
    }
  }
  sendCommand(v, 'toast', v.mediaMode ? 'Media mode' : 'Browse mode');
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
  v.cssKey = null;

  contents.on('dom-ready', () => injectInto(v, contents, true));
  contents.on('did-finish-load', () => injectInto(v, contents, false));
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
    cssKey: null,
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
    // Persistent storage: cookies and logins survive an app restart
    // and are shared by all viewer windows.
    webPreferences.partition = 'persist:viewer';
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
const GUEST_ACTIONS = new Set(['fullscreen', 'reload', 'fit', 'browse']);

ipcMain.on('viewer:action', (event, name) => {
  const v = viewerOf(event.sender);
  if (!v || !Object.hasOwn(ACTIONS, name)) return;
  if (event.sender === v.guest && !GUEST_ACTIONS.has(name)) return;
  ACTIONS[name](v);
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

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => app.quit());
