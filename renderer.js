// Renderer for the UI window: the URL bar and control of the <webview> element.
const view = document.getElementById('view');
const bar = document.getElementById('bar');
const form = document.getElementById('form');
const input = document.getElementById('url');
const pasteButton = document.getElementById('paste');
const msg = document.getElementById('msg');
const toast = document.getElementById('toast');

let loaded = false; // a page has been loaded (or is loading)

// Adds the protocol when the user left it out.
function normalizeUrl(raw) {
  const text = String(raw || '').trim();
  if (!text) return '';
  if (/^(https?|file|data|blob|about):/i.test(text)) return text;
  if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(text)) return `http://${text}`;
  return `https://${text}`;
}

function showBar() {
  bar.classList.remove('hidden');
  window.viewer.setBarVisible(true);
  if (loaded) {
    try {
      input.value = view.getURL() || input.value;
    } catch {
      // <webview> is not ready yet – keep the last value the user entered.
    }
  }
  input.focus();
  input.select();
}

function hideBar() {
  bar.classList.add('hidden');
  window.viewer.setBarVisible(false);
  view.focus();
}

function toggleBar() {
  if (bar.classList.contains('hidden')) showBar();
  else if (loaded) hideBar(); // on the home screen there is nothing to reveal
}

function openUrl(raw) {
  const url = normalizeUrl(raw);
  if (!url) return;
  msg.textContent = '';
  input.value = url;
  loaded = true;
  document.body.classList.add('loaded');
  view.src = url;
  hideBar();
}

let toastTimer = null;
function showToast(text) {
  toast.textContent = text;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 1200);
}

// --- URL bar ---------------------------------------------------------------

form.addEventListener('submit', (event) => {
  event.preventDefault();
  openUrl(input.value);
});

pasteButton.addEventListener('click', async () => {
  const text = await window.viewer.readClipboard();
  if (text && text.trim()) {
    openUrl(text);
  } else {
    msg.textContent = 'The clipboard contains no text.';
    input.focus();
  }
});

document.getElementById('fullscreen').addEventListener('click', () => {
  window.viewer.action('fullscreen');
});

document.getElementById('new-window').addEventListener('click', () => {
  window.viewer.action('new-window');
});

document.getElementById('close').addEventListener('click', () => {
  window.viewer.action('close');
});

// A click outside the bar closes the floating overlay. It waits a moment for a
// second click – a double-click should toggle fullscreen, not close the overlay.
let backdropTimer = null;
bar.addEventListener('click', (event) => {
  if (event.target !== bar || !loaded) return;
  clearTimeout(backdropTimer);
  if (event.detail === 1) backdropTimer = setTimeout(hideBar, 280);
});

// --- Loaded page -----------------------------------------------------------

view.addEventListener('did-fail-load', (event) => {
  // -3 = ERR_ABORTED (e.g. a redirect or a new navigation), which is not an error.
  if (!event.isMainFrame || event.errorCode === -3) return;
  showBar();
  msg.textContent = `Failed to load the page: ${event.errorDescription || event.errorCode}`;
});

// --- Shortcuts and double-click while the UI window has focus --------------

const KEY_ACTIONS = { f: 'fullscreen', r: 'reload', c: 'fit', b: 'browse' };

document.addEventListener('keydown', (event) => {
  if (event.ctrlKey || event.metaKey || event.altKey || event.repeat) return;
  if (event.target === input) return;
  const action = KEY_ACTIONS[event.key.toLowerCase()];
  if (action) {
    event.preventDefault();
    window.viewer.action(action);
  }
});

document.addEventListener('dblclick', (event) => {
  if (event.target.closest('#form, #actions')) return;
  clearTimeout(backdropTimer);
  window.viewer.action('fullscreen');
});

// --- Commands from the main process ----------------------------------------

window.viewer.onCommand((name, data) => {
  if (name === 'toggle-bar') toggleBar();
  else if (name === 'toast') showToast(data);
  else if (name === 'fullscreen') document.body.classList.toggle('fullscreen', Boolean(data));
});

window.viewer.setBarVisible(true);
input.focus();
