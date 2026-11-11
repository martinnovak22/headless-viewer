// Main process: frameless window, keyboard shortcuts and tweaks to loaded pages.
const { app, BrowserWindow, Menu, clipboard, ipcMain } = require('electron');
const path = require('node:path');

const isMac = process.platform === 'darwin';

// Media should start playing right after load, without a click.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

let win = null; // main window (index.html)
let guest = null; // webContents of the <webview> element holding the loaded page
let guestHtmlFullscreen = false; // the page itself put a <video> into fullscreen
let fit = 'contain'; // 'contain' = Fit, 'cover' = Fill
let mediaMode = true; // false = browse mode: the page is left untouched (signing in etc.)
let cssKey = null; // key of the CSS inserted into the current document

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

async function applyCss(contents) {
  if (contents.isDestroyed()) return;
  try {
    const key = await contents.insertCSS(INJECTED_CSS);
    // The user may have switched to browse mode in the meantime.
    if (mediaMode) cssKey = key;
    else contents.removeInsertedCSS(key).catch(() => {});
  } catch {
    // The document is gone by now (new navigation).
  }
}

function injectInto(contents, newDocument) {
  if (contents.isDestroyed()) return;
  if (newDocument) {
    cssKey = null; // the previous document's CSS went away with it
    if (mediaMode) applyCss(contents);
  }
  contents.executeJavaScript(injectedScript(fit)).catch(() => {});
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function sendCommand(name, data) {
  if (win && !win.isDestroyed()) win.webContents.send('viewer:command', name, data);
}

function toggleFullscreen() {
  if (win) win.setFullScreen(!win.isFullScreen());
}

function reload() {
  if (guest && !guest.isDestroyed()) guest.reload();
}

function goBack() {
  if (guest && !guest.isDestroyed() && guest.navigationHistory.canGoBack()) {
    guest.navigationHistory.goBack();
  }
}

function goForward() {
  if (guest && !guest.isDestroyed() && guest.navigationHistory.canGoForward()) {
    guest.navigationHistory.goForward();
  }
}

function toggleFit() {
  fit = fit === 'contain' ? 'cover' : 'contain';
  if (guest && !guest.isDestroyed()) {
    guest
      .executeJavaScript(
        `document.documentElement.setAttribute('data-hv-fit', ${JSON.stringify(fit)})`
      )
      .catch(() => {});
  }
  sendCommand('toast', fit === 'cover' ? 'Fill' : 'Fit');
}

// Browse mode turns the page tweaks off so the page can be used normally
// (signing in, searching, scrolling). Media mode turns them back on.
function toggleMediaMode() {
  mediaMode = !mediaMode;
  if (guest && !guest.isDestroyed()) {
    if (mediaMode) {
      applyCss(guest);
    } else if (cssKey) {
      guest.removeInsertedCSS(cssKey).catch(() => {});
      cssKey = null;
    }
  }
  sendCommand('toast', mediaMode ? 'Media mode' : 'Browse mode');
}

const ACTIONS = {
  fullscreen: toggleFullscreen,
  reload,
  fit: toggleFit,
  browse: toggleMediaMode,
  close: () => win && win.close(),
};

// Shortcuts with modifiers and function keys. They are caught in the main
// process so they behave the same whether the home screen or the loaded page
// has focus. Bare letters (F, R, C, B) are handled by the renderer and
// webview-preload, because they need to know whether the user is typing in a
// text field.
function handleInput(event, input) {
  if (input.type !== 'keyDown') return;
  const key = input.key.toLowerCase();
  const mod = input.control || input.meta; // Ctrl (Windows/Linux) or Cmd (macOS)

  let handler = null;
  if (mod && !input.alt && key === 'l') handler = () => sendCommand('toggle-bar');
  else if (key === 'escape' && !guestHtmlFullscreen) handler = () => sendCommand('toggle-bar');
  else if (key === 'f11') handler = toggleFullscreen;
  else if (mod && !input.alt && key === 'r') handler = reload;
  else if (mod && !input.alt && key === 'b') handler = toggleMediaMode;
  else if (mod && !input.alt && key === 'q') handler = () => app.quit();
  else if (input.alt && key === 'arrowleft' && !isEditingUrl(event)) handler = goBack;
  else if (input.alt && key === 'arrowright' && !isEditingUrl(event)) handler = goForward;

  if (handler) {
    event.preventDefault();
    handler();
  }
}

// Alt+arrow inside the URL bar should move the caret, not the history.
let urlBarVisible = true;
function isEditingUrl(event) {
  return urlBarVisible && win && event.sender === win.webContents;
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

function setupGuest(contents) {
  guest = contents;
  guestHtmlFullscreen = false;
  cssKey = null;

  contents.on('dom-ready', () => injectInto(contents, true));
  contents.on('did-finish-load', () => injectInto(contents, false));
  contents.on('before-input-event', handleInput);
  contents.on('enter-html-full-screen', () => (guestHtmlFullscreen = true));
  contents.on('leave-html-full-screen', () => (guestHtmlFullscreen = false));

  // No new windows – target=_blank links open in place.
  contents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) contents.loadURL(url).catch(() => {});
    return { action: 'deny' };
  });

  contents.on('destroyed', () => {
    if (guest === contents) guest = null;
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 720,
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

  win.once('ready-to-show', () => win.show());
  win.on('closed', () => {
    win = null;
    guest = null;
  });
  win.on('enter-full-screen', () => sendCommand('fullscreen', true));
  win.on('leave-full-screen', () => sendCommand('fullscreen', false));

  const host = win.webContents;
  host.on('before-input-event', handleInput);

  // The UI window must never navigate away or open other windows.
  host.on('will-navigate', (event) => event.preventDefault());
  host.setWindowOpenHandler(() => ({ action: 'deny' }));

  // The loaded page runs isolated, with only our small preload.
  host.on('will-attach-webview', (_event, webPreferences) => {
    webPreferences.preload = path.join(__dirname, 'webview-preload.js');
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
    // Persistent storage: cookies and logins survive an app restart.
    webPreferences.partition = 'persist:viewer';
  });
  host.on('did-attach-webview', (_event, contents) => setupGuest(contents));

  win.loadFile(path.join(__dirname, 'index.html'));
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

function isKnownSender(event) {
  return (win && event.sender === win.webContents) || (guest && event.sender === guest);
}

ipcMain.on('viewer:action', (event, name) => {
  if (!isKnownSender(event)) return;
  const action = Object.hasOwn(ACTIONS, name) ? ACTIONS[name] : null;
  if (action) action();
});

ipcMain.on('viewer:bar-visible', (event, visible) => {
  if (win && event.sender === win.webContents) urlBarVisible = Boolean(visible);
});

ipcMain.handle('viewer:read-clipboard', (event) => {
  if (!win || event.sender !== win.webContents) return '';
  return clipboard.readText();
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
