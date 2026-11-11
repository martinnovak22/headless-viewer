// Hlavní proces: bezrámečkové okno, klávesové zkratky a úprava načtených stránek.
const { app, BrowserWindow, Menu, clipboard, ipcMain } = require('electron');
const path = require('node:path');

const isMac = process.platform === 'darwin';

// Média se mají přehrát hned po načtení, bez kliknutí.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

let win = null; // hlavní okno (index.html)
let guest = null; // webContents elementu <webview> s načtenou stránkou
let guestHtmlFullscreen = false; // stránka sama přepnula <video> do fullscreenu
let fit = 'contain'; // 'contain' = Přizpůsobit, 'cover' = Vyplnit
let mediaMode = true; // false = režim prohlížení: stránka se neupravuje (přihlášení apod.)
let cssKey = null; // klíč vloženého CSS v aktuálním dokumentu

// Weby často odmítají přihlášení z „neznámého“ prohlížeče – tváříme se jako běžný Chrome.
app.userAgentFallback = app.userAgentFallback
  .replace(/\s(Electron|headless-viewer|HeadlessViewer)\/\S+/gi, '');

// ---------------------------------------------------------------------------
// CSS a JS vkládané do každé načtené stránky
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

// Najde hlavní médium stránky a označí ho atributem data-hv-main.
// Skript je idempotentní – lze ho volat opakovaně (dom-ready i did-finish-load).
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
        // Přímý odkaz na soubor – Chromium ho zabalí do jednoduchého dokumentu.
        target = document.querySelector('video, img');
      } else {
        // Běžná stránka: největší <video>, případně jediný <img> na stránce.
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

    // Přehrávače často vkládají <video> až dodatečně.
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
    // Mezitím mohl uživatel přepnout do režimu prohlížení.
    if (mediaMode) cssKey = key;
    else contents.removeInsertedCSS(key).catch(() => {});
  } catch {
    // Dokument mezitím zanikl (nová navigace).
  }
}

function injectInto(contents, newDocument) {
  if (contents.isDestroyed()) return;
  if (newDocument) {
    cssKey = null; // CSS z předchozího dokumentu zaniklo s ním
    if (mediaMode) applyCss(contents);
  }
  contents.executeJavaScript(injectedScript(fit)).catch(() => {});
}

// ---------------------------------------------------------------------------
// Akce
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
  sendCommand('toast', fit === 'cover' ? 'Vyplnit' : 'Přizpůsobit');
}

// Režim prohlížení vypne úpravy stránky, aby šla normálně používat
// (přihlášení, hledání, posouvání). Režim médií je zase zapne.
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
  sendCommand('toast', mediaMode ? 'Režim médií' : 'Režim prohlížení');
}

const ACTIONS = {
  fullscreen: toggleFullscreen,
  reload,
  fit: toggleFit,
  browse: toggleMediaMode,
  close: () => win && win.close(),
};

// Zkratky s modifikátory a funkční klávesy. Zachytávají se v hlavním procesu,
// aby fungovaly stejně, ať má fokus úvodní obrazovka, nebo načtená stránka.
// Samotná písmena (F, R, C) řeší renderer a webview-preload, protože musí
// vědět, jestli uživatel zrovna nepíše do textového pole.
function handleInput(event, input) {
  if (input.type !== 'keyDown') return;
  const key = input.key.toLowerCase();
  const mod = input.control || input.meta; // Ctrl (Windows/Linux) i Cmd (macOS)

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

// Alt/Cmd+šipka v řádku pro URL má hýbat kurzorem, ne historií.
let urlBarVisible = true;
function isEditingUrl(event) {
  return urlBarVisible && win && event.sender === win.webContents;
}

// ---------------------------------------------------------------------------
// Okno
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

  // Žádná nová okna – odkazy s target=_blank se otevřou na místě.
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

  // Okno s UI se nikdy nesmí přesměrovat jinam ani otevírat další okna.
  host.on('will-navigate', (event) => event.preventDefault());
  host.setWindowOpenHandler(() => ({ action: 'deny' }));

  // Načtená stránka běží izolovaně, jen s naším malým preloadem.
  host.on('will-attach-webview', (_event, webPreferences) => {
    webPreferences.preload = path.join(__dirname, 'webview-preload.js');
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
    // Trvalé úložiště: cookies a přihlášení přežijí restart aplikace.
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
    // macOS potřebuje nabídku kvůli Cmd+C/V/X/A v textovém poli a Cmd+Q.
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
