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
  closeLayouts();
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

const loopButton = document.getElementById('loop');
loopButton.addEventListener('click', () => window.viewer.action('loop'));

const lockButton = document.getElementById('lock');
lockButton.addEventListener('click', () => window.viewer.action('lock'));

// --- Layouts panel -----------------------------------------------------------

const layoutsPanel = document.getElementById('layouts');
const layoutBrowser = document.getElementById('layout-browser');
const layoutList = document.getElementById('layout-list');
const newLayoutButton = document.getElementById('layout-new');
const editor = document.getElementById('editor');
const edName = document.getElementById('ed-name');
const edCols = document.getElementById('ed-cols');
const edRows = document.getElementById('ed-rows');
const edGrid = document.getElementById('ed-grid');
const edMsg = document.getElementById('ed-msg');

let layoutState = null; // { layouts, isDefault, max, maxGrid, maxZones }
let editing = null; // { index (null = new), cols, rows, zones }

function zoneStyle(el, [c, r, w, h]) {
  el.style.gridColumn = `${c + 1} / span ${w}`;
  el.style.gridRow = `${r + 1} / span ${h}`;
}

function gridTemplate(el, cols, rows) {
  el.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
  el.style.gridTemplateRows = `repeat(${rows}, 1fr)`;
}

function smallButton(text, className, onClick) {
  const el = document.createElement('span');
  el.textContent = text;
  el.className = className;
  el.addEventListener('click', (event) => {
    event.stopPropagation();
    onClick();
  });
  return el;
}

function renderLayouts() {
  const { layouts, isDefault, max } = layoutState;
  layoutList.replaceChildren(
    ...layouts.map((layout, index) => {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'card';
      card.title = `Arrange all windows (${isMac() ? '⌘⌥' : 'Ctrl+Alt+'}${index + 1})`;
      const thumb = document.createElement('div');
      thumb.className = 'thumb';
      gridTemplate(thumb, layout.cols, layout.rows);
      for (const zone of layout.zones) {
        const el = document.createElement('div');
        zoneStyle(el, zone);
        thumb.append(el);
      }
      const label = document.createElement('span');
      label.className = 'label';
      const key = document.createElement('span');
      key.className = 'key';
      key.textContent = index + 1;
      label.append(key, layout.name);
      const tools = document.createElement('span');
      tools.className = 'tools';
      tools.append(
        smallButton('✎', 'edit', () => openEditor(index)),
        smallButton('×', 'delete', () => saveLayouts(layouts.filter((_, i) => i !== index)))
      );
      card.append(thumb, label, tools);
      card.addEventListener('click', () => {
        window.viewer.applyLayout(index);
        closeLayouts();
        if (loaded) hideBar();
      });
      return card;
    })
  );
  newLayoutButton.disabled = layouts.length >= max;
  document.getElementById('layout-reset').disabled = isDefault;
}

function isMac() {
  return navigator.platform.toLowerCase().includes('mac');
}

async function saveLayouts(list) {
  layoutState = await window.viewer.saveLayouts(list);
  renderLayouts();
}

async function openLayouts() {
  layoutState = await window.viewer.getLayouts();
  if (!layoutState) return;
  closeEditor();
  renderLayouts();
  layoutsPanel.hidden = false;
}

function closeLayouts() {
  layoutsPanel.hidden = true;
}

document.getElementById('layouts-toggle').addEventListener('click', () => {
  if (layoutsPanel.hidden) openLayouts();
  else closeLayouts();
});
newLayoutButton.addEventListener('click', () => openEditor(null));
document.getElementById('layout-reset').addEventListener('click', () => saveLayouts(null));

// --- Grid editor ---------------------------------------------------------------

function openEditor(index) {
  const source = index === null ? { name: '', cols: 4, rows: 2, zones: [] } : layoutState.layouts[index];
  editing = {
    index,
    cols: source.cols,
    rows: source.rows,
    zones: source.zones.map((zone) => [...zone]),
  };
  edName.value = source.name;
  edCols.value = editing.cols;
  edRows.value = editing.rows;
  edMsg.textContent = '';
  layoutBrowser.hidden = true;
  editor.hidden = false;
  renderEditor();
  edName.focus();
}

function closeEditor() {
  editing = null;
  editor.hidden = true;
  layoutBrowser.hidden = false;
}

function overlaps(a, b) {
  return a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3];
}

function renderEditor() {
  const { cols, rows, zones } = editing;
  gridTemplate(edGrid, cols, rows);
  const children = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cell = document.createElement('div');
      cell.className = 'cell';
      cell.dataset.c = c;
      cell.dataset.r = r;
      zoneStyle(cell, [c, r, 1, 1]);
      children.push(cell);
    }
  }
  zones.forEach((zone, i) => {
    const el = document.createElement('div');
    el.className = i === 0 ? 'zone main' : 'zone';
    el.textContent = i + 1;
    el.title = 'Remove this zone';
    zoneStyle(el, zone);
    el.addEventListener('click', () => {
      zones.splice(i, 1);
      renderEditor();
    });
    children.push(el);
  });
  edGrid.replaceChildren(...children);
}

function setGridSize() {
  const max = layoutState.maxGrid;
  const clamp = (input) => Math.min(max, Math.max(1, Math.round(Number(input.value)) || 1));
  editing.cols = clamp(edCols);
  editing.rows = clamp(edRows);
  // Zones that no longer fit are dropped.
  editing.zones = editing.zones.filter(
    ([c, r, w, h]) => c + w <= editing.cols && r + h <= editing.rows
  );
  renderEditor();
}
edCols.addEventListener('change', setGridSize);
edRows.addEventListener('change', setGridSize);

// Dragging across cells draws a new zone.
let drawFrom = null; // [col, row] where the drag started
let preview = null;

function cellAt(event) {
  const el = document.elementFromPoint(event.clientX, event.clientY);
  return el && el.classList.contains('cell') ? [Number(el.dataset.c), Number(el.dataset.r)] : null;
}

function rectBetween([c1, r1], [c2, r2]) {
  const c = Math.min(c1, c2);
  const r = Math.min(r1, r2);
  return [c, r, Math.abs(c1 - c2) + 1, Math.abs(r1 - r2) + 1];
}

function drawAllowed(rect) {
  return (
    !editing.zones.some((zone) => overlaps(zone, rect)) &&
    editing.zones.length < layoutState.maxZones
  );
}

edGrid.addEventListener('pointerdown', (event) => {
  const cell = cellAt(event);
  if (!cell) return;
  event.preventDefault();
  edGrid.setPointerCapture(event.pointerId);
  drawFrom = cell;
  preview = document.createElement('div');
  preview.className = 'preview';
  edGrid.append(preview);
  updatePreview(cell);
});

function updatePreview(cell) {
  const rect = rectBetween(drawFrom, cell);
  zoneStyle(preview, rect);
  preview.classList.toggle('bad', !drawAllowed(rect));
  preview.rect = rect;
}

edGrid.addEventListener('pointermove', (event) => {
  if (!drawFrom) return;
  const cell = cellAt(event);
  if (cell) updatePreview(cell);
});

edGrid.addEventListener('pointerup', () => {
  if (!drawFrom) return;
  const rect = preview.rect;
  drawFrom = null;
  preview.remove();
  preview = null;
  if (drawAllowed(rect)) editing.zones.push(rect);
  renderEditor();
});

document.getElementById('ed-cancel').addEventListener('click', closeEditor);

document.getElementById('ed-save').addEventListener('click', async () => {
  if (editing.zones.length === 0) {
    edMsg.textContent = 'Draw at least one zone.';
    return;
  }
  const layout = {
    name: edName.value.trim() || `${editing.cols} × ${editing.rows}`,
    cols: editing.cols,
    rows: editing.rows,
    zones: editing.zones,
  };
  const list = [...layoutState.layouts];
  if (editing.index === null) list.push(layout);
  else list[editing.index] = layout;
  await saveLayouts(list);
  closeEditor();
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

const KEY_ACTIONS = { f: 'fullscreen', r: 'reload', c: 'fit', l: 'loop', b: 'browse', a: 'adblock' };

document.addEventListener('keydown', (event) => {
  if (event.ctrlKey || event.metaKey || event.altKey || event.repeat) return;
  if (event.target.closest('input')) return;
  const action = KEY_ACTIONS[event.key.toLowerCase()];
  if (action) {
    event.preventDefault();
    window.viewer.action(action);
  }
});

document.addEventListener('dblclick', (event) => {
  if (event.target.closest('#form, #actions, #layouts')) return;
  clearTimeout(backdropTimer);
  window.viewer.action('fullscreen');
});

// --- Commands from the main process ----------------------------------------

window.viewer.onCommand((name, data) => {
  if (name === 'toggle-bar') toggleBar();
  else if (name === 'toast') showToast(data);
  else if (name === 'open') openUrl(data);
  else if (name === 'loop') loopButton.textContent = data ? 'Loop: on' : 'Loop: off';
  else if (name === 'fullscreen') document.body.classList.toggle('fullscreen', Boolean(data));
  else if (name === 'locked') {
    document.body.classList.toggle('locked', Boolean(data));
    lockButton.textContent = data ? 'Unlock layout' : 'Lock layout';
  }
});

window.viewer.setBarVisible(true);
input.focus();
