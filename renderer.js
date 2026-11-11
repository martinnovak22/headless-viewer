// Renderer okna s UI: řádek pro URL a ovládání elementu <webview>.
const view = document.getElementById('view');
const bar = document.getElementById('bar');
const form = document.getElementById('form');
const input = document.getElementById('url');
const pasteButton = document.getElementById('paste');
const msg = document.getElementById('msg');
const toast = document.getElementById('toast');

let loaded = false; // už se načetla (nebo načítá) nějaká stránka

// Doplní protokol, pokud ho uživatel nezadal.
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
      // <webview> ještě není připravený – ponecháme poslední zadanou hodnotu.
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
  else if (loaded) hideBar(); // na úvodní obrazovce není co odkrýt
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

// --- Řádek pro URL ---------------------------------------------------------

form.addEventListener('submit', (event) => {
  event.preventDefault();
  openUrl(input.value);
});

pasteButton.addEventListener('click', async () => {
  const text = await window.viewer.readClipboard();
  if (text && text.trim()) {
    openUrl(text);
  } else {
    msg.textContent = 'Schránka neobsahuje žádný text.';
    input.focus();
  }
});

document.getElementById('fullscreen').addEventListener('click', () => {
  window.viewer.action('fullscreen');
});

document.getElementById('close').addEventListener('click', () => {
  window.viewer.action('close');
});

// Klik mimo řádek plovoucí překryv zavře. Čeká se chvilku, jestli nepřijde
// druhý klik – dvojklik má přepnout celou obrazovku, ne zavřít překryv.
let backdropTimer = null;
bar.addEventListener('click', (event) => {
  if (event.target !== bar || !loaded) return;
  clearTimeout(backdropTimer);
  if (event.detail === 1) backdropTimer = setTimeout(hideBar, 280);
});

// --- Načtená stránka -------------------------------------------------------

view.addEventListener('did-fail-load', (event) => {
  // -3 = ERR_ABORTED (např. přesměrování nebo nová navigace), to není chyba.
  if (!event.isMainFrame || event.errorCode === -3) return;
  showBar();
  msg.textContent = `Stránku se nepodařilo načíst: ${event.errorDescription || event.errorCode}`;
});

// --- Zkratky a dvojklik, když má fokus okno s UI ---------------------------

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

// --- Příkazy z hlavního procesu --------------------------------------------

window.viewer.onCommand((name, data) => {
  if (name === 'toggle-bar') toggleBar();
  else if (name === 'toast') showToast(data);
  else if (name === 'fullscreen') document.body.classList.toggle('fullscreen', Boolean(data));
});

window.viewer.setBarVisible(true);
input.focus();
