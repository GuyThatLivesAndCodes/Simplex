/* files.js — every Database listing in the new UI: a folder, a category, Starred,
   Recent, Trash and search results. One renderer, one selection model, one set
   of actions. Opening a file hands off to viewer.js; uploads go to upload.js. */
import { html, raw, el, icon, esc, fmtSize, fmtDate, fmtDur, ext, plural, lsGet, lsSet, $$, animate, SPRING } from './lib.js';
import * as store from './store.js';
import { toast, menu, dialog, confirm, prompt, seg } from './ui.js';
import { openViewer } from './viewer.js';
import { pickAndUpload } from './upload.js';
import * as prefs from './prefs.js';
import { lazy, cancelThumbs } from './thumbs.js';
import { queueDownload, canConvert, convertDialog, canAiEdit, aiEditDialog } from './jobs.js';

const PAGE = 120;   // cards rendered per batch; more stream in as you scroll (smaller = shorter hitches on slow CPUs)
let sort = JSON.parse(lsGet('nx.sort', '{"key":"name","dir":"asc"}'));
const sel = new Set();
let anchor = null;     // last clicked id, for shift-range selection
let ctx = null;        // { route, items, root }

export const go = hash => { if (location.hash !== hash) location.hash = hash; };
export const hrefFolder = id => '#/files' + (id ? '/' + id : '');

/* ---------- describe the current listing ---------- */
function describe(route) {
  const { name, arg, q } = route;
  if (name === 'files') {
    const folder = arg ? store.byId(arg) : null;
    if (arg && (!folder || folder.trashed)) return { title: 'Folder not found', items: [], missing: true };
    return { title: folder ? folder.name : 'All files', items: store.children(arg || null), folder: arg || null, crumbs: arg ? store.pathOf(arg) : [], canCreate: true, ic: 'folder', tint: 't-folder' };
  }
  if (name === 'c') {
    const c = store.CATEGORIES.find(c => c.path === arg) || store.CATEGORIES[0];
    return { title: c.label, items: store.ofType(c.id), ic: c.ic, tint: 't-' + c.id, flat: true, empty: `No ${c.label.toLowerCase()} yet` };
  }
  if (name === 'starred') return { title: 'Starred', items: store.starred(), ic: 'star', tint: 't-folder', flat: true, empty: 'Star things to keep them close' };
  if (name === 'recent') return { title: 'Recent', items: store.recent(120), ic: 'clock', tint: 't-app', flat: true, keepOrder: true, empty: 'Nothing here yet' };
  if (name === 'trash') return { title: 'Trash', items: store.trashed(), ic: 'trash', tint: 't-video', flat: true, trash: true, empty: 'Trash is empty' };
  if (name === 'search') return { title: q ? `“${q}”` : 'Search', items: store.search(q || '', 400), ic: 'search', tint: 't-app', flat: true, keepOrder: true, search: true, empty: 'No matches' };
  return { title: 'Files', items: [] };
}

/* ---------- render ---------- */
const view = () => (prefs.get('view') === 'list' ? 'list' : 'grid');
/* display name honoring Settings → Show file extensions */
export const dispName = f => (f.type === 'folder' || prefs.get('showExt')) ? f.name : f.name.replace(/\.[^.\s]{1,8}$/, '') || f.name;
const ordered = d => d.keepOrder ? d.items : store.sortItems(d.items, sort.key, sort.dir, prefs.get('foldersFirst'));

/* a fingerprint of what the listing shows: background refreshes that don't change
   it are skipped, so a poll can never re-render (and snap) a view mid-animation */
export function signature(route) {
  const d = describe(route);
  return [view(), sort.key, sort.dir, prefs.get('showExt'), prefs.get('foldersFirst'), d.title,
    ...ordered(d).map(f => [f.id, f.name, f.starred ? 1 : 0, f.size, f.date, f.parent, f.locked ? 1 : 0].join(':'))].join('|');
}

export function renderFiles(root, route) {
  dropObservers();   // a quiet re-render replaces the page: release the old one's watchers
  const d = describe(route);
  const items = ordered(d);
  ctx = { route, items, root, d };
  [...sel].forEach(id => { if (!items.some(f => f.id === id)) sel.delete(id); });

  const totalSize = items.reduce((n, f) => n + (f.type === 'folder' ? 0 : f.size || 0), 0);
  const crumbs = d.crumbs && d.crumbs.length ? html`<nav class="crumbs" aria-label="Path">
      <button data-go="${hrefFolder(null)}" data-drop="">All files</button>
      ${d.crumbs.slice(0, -1).map(f => html`${icon('chevron', 13)}<button data-go="${hrefFolder(f.id)}" data-drop="${f.id}">${f.name}</button>`)}
    </nav>` : '';
  root.innerHTML = html`<div class="page page-enter">
    <header class="fhead">
      <div>
        ${crumbs}
        <h1>${d.title}</h1>
        <div class="meta">${plural(items.length, 'item')}${totalSize ? ' · ' + fmtSize(totalSize) : ''}</div>
      </div>
      <div class="acts">
        ${d.trash && items.length ? html`<button class="b danger" data-act="empty">${icon('trash', 16)} Empty trash</button>` : ''}
        ${d.canCreate ? html`<button class="b" data-act="newfolder">${icon('newfolder', 16)} New folder</button><button class="b pri" data-act="upload">${icon('upload', 16)} Upload</button>` : ''}
        <button class="b flat sm" data-act="sort" title="Sort">${icon('sort', 16)} ${({ name: 'Name', date: 'Date', size: 'Size', type: 'Kind' })[sort.key]}</button>
        <div class="seg" data-seg="view"><button data-v="grid" aria-label="Grid">${icon('grid', 16)}</button><button data-v="list" aria-label="List">${icon('list', 16)}</button></div>
      </div>
    </header>
    <section class="fbody"></section>
  </div>`.s;

  // listeners go on this freshly built page, never on `root` (the long-lived stage),
  // so re-renders don't stack handlers
  const page = root.firstElementChild;
  ctx.root = page;
  const body = page.querySelector('.fbody');
  if (d.missing) body.innerHTML = emptyHTML('folder', 'This folder is gone', 'It may have been moved to Trash or deleted.');
  else if (!items.length) body.innerHTML = emptyHTML(d.ic, d.empty || 'This folder is empty', d.canCreate ? 'Drop files anywhere to upload them here.' : '');
  else paint(body, items, d);

  seg(page.querySelector('[data-seg=view]'), view(), v => prefs.set({ view: v }));
  wireHeader(page, root, d);
  if (!d.trash) wireDrag(page);
  page.addEventListener('contextmenu', e => {
    if (e.target.closest('[data-id], input, textarea, .crumbs button')) return;   // items handle their own
    e.preventDefault(); backgroundMenu({ x: e.clientX, y: e.clientY });
  });
  syncSelbar();
}

function emptyHTML(ic, title, sub) {
  return html`<div class="empty"><div class="ei">${icon(ic, 30, 1.5)}</div><b>${title}</b>${sub ? html`<span>${sub}</span>` : ''}</div>`.s;
}

function paint(body, items, d) {
  const box = el(view() === 'grid' ? '<div class="fgrid"></div>' : html`<div class="flist" role="grid">
      <div class="lh"><span></span>${['name', 'size', 'type', 'date'].map(k => html`<button data-sort="${k}" class="${sort.key === k ? 'on' : ''}">${({ name: 'Name', size: 'Size', type: 'Kind', date: 'Modified' })[k]}${sort.key === k ? icon(sort.dir === 'asc' ? 'arrowup' : 'arrowdown', 12, 2) : ''}</button>`)}<span></span></div></div>`.s);
  body.appendChild(box);
  let shown = 0;
  // first batch: just enough to fill the screen (with margin), so a big folder
  // paints immediately; the rest streams in by PAGE as you scroll
  const cardW = view() === 'grid' ? (parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--card-w')) || 176) : 0;
  const first = cardW ? Math.ceil((innerWidth / (cardW + 16)) * (innerHeight / (cardW * 0.95 + 16)) * 1.6) : Math.ceil(innerHeight / 52 * 1.6);
  let batch = Math.max(36, Math.min(PAGE, first));
  const more = () => {
    const chunk = items.slice(shown, shown + batch);
    batch = PAGE;
    box.insertAdjacentHTML('beforeend', chunk.map((f, i) => (view() === 'grid' ? cardHTML : rowHTML)(f, shown + i, d)).join(''));
    shown += chunk.length;
    observers.push(lazy(box, thumbFail));
    if (shown < items.length) {
      const s = el('<div style="height:1px;grid-column:1/-1"></div>'); box.appendChild(s);
      const io = new IntersectionObserver(es => { if (es[0].isIntersecting) { io.disconnect(); s.remove(); more(); } }, { rootMargin: '800px' });
      io.observe(s); observers.push(io);
    }
  };
  more();
  wireItems(box, d);
}

function sub(f, d) {
  if (f.type === 'folder') return plural(store.childCount(f.id), 'item');
  const bits = [fmtSize(f.size)];
  if (d.search || d.flat) { const p = store.pathOf(f.id).slice(0, -1).pop(); bits.push(p ? p.name : 'All files'); }
  else bits.push(fmtDate(f.date));
  return bits.join(' · ');
}
function thumbHTML(f, big = 30) {
  const t = store.thumbUrl(f);
  return t ? raw(`<img data-src="${esc(t)}" alt="" draggable="false">`) : html`<span class="big tint t-${f.type}">${icon(f.type === 'folder' ? 'folder' : f.type, big, 1.6)}</span>`;
}
function cardHTML(f, i, d) {
  const tag = f.type === 'folder' ? '' : (ext(f.name) || f.type);
  return html`<article class="fcard${sel.has(f.id) ? ' sel' : ''}" data-id="${f.id}" style="--i:${i}" draggable="${d.trash ? 'false' : 'true'}" tabindex="0" ${f.type === 'folder' ? raw(`data-drop="${esc(f.id)}"`) : ''}>
    <span class="ck" data-check aria-label="Select">${icon('check', 14, 2.6)}</span>
    ${f.starred ? html`<span class="star">${icon('star', 16, 2)}</span>` : ''}
    <button class="ib sm mo" data-more aria-label="More">${icon('more', 16)}</button>
    <div class="th">${thumbHTML(f, 30)}${tag ? html`<span class="tag">${tag}</span>` : ''}${f.dur ? html`<span class="tag dur">${fmtDur(f.dur)}</span>` : ''}</div>
    <div class="nm" title="${f.name}">${dispName(f)}</div>
    <div class="sb">${f.locked ? icon('lock', 12) : ''}${sub(f, d)}</div>
  </article>`.s;
}
function rowHTML(f, i, d) {
  return html`<div class="frow${sel.has(f.id) ? ' sel' : ''}" data-id="${f.id}" style="--i:${i}" draggable="${d.trash ? 'false' : 'true'}" tabindex="0" role="row" ${f.type === 'folder' ? raw(`data-drop="${esc(f.id)}"`) : ''}>
    <span class="ri tint t-${f.type}">${thumbHTML(f, 18)}<span class="ck" data-check>${icon('check', 14, 2.6)}</span></span>
    <span class="nm-wrap"><span class="nm" title="${f.name}">${dispName(f)}${f.starred ? icon('star', 13, 2) : ''}${f.locked ? icon('lock', 13) : ''}</span><small>${sub(f, d)}</small></span>
    <span class="c">${f.type === 'folder' ? '—' : fmtSize(f.size)}</span>
    <span class="c">${f.type === 'folder' ? 'Folder' : (ext(f.name) || f.type).toUpperCase()}</span>
    <span class="c">${fmtDate(f.date)}</span>
    <button class="ib sm" data-more aria-label="More">${icon('more', 16)}</button>
  </div>`.s;
}
function thumbFail(img) {
  const n = img.closest('[data-id]'); const f = n && store.byId(n.dataset.id);
  img.replaceWith(el(html`<span class="big tint t-${f ? f.type : 'document'}">${icon(f ? f.type : 'file', 30, 1.6)}</span>`.s));
}

/* ---------- interaction ---------- */
function wireHeader(page, root, d) {
  page.addEventListener('click', async e => {
    const g = e.target.closest('[data-go]'); if (g) return go(g.dataset.go);
    const s = e.target.closest('[data-sort]');
    if (s) { const k = s.dataset.sort; sort = { key: k, dir: sort.key === k && sort.dir === 'asc' ? 'desc' : 'asc' }; lsSet('nx.sort', JSON.stringify(sort)); return renderFiles(root, ctx.route); }
    const a = e.target.closest('[data-act]'); if (!a) return;
    const act = a.dataset.act;
    if (act === 'newfolder') newFolder(d.folder);
    else if (act === 'upload') pickAndUpload(d.folder);
    else if (act === 'empty') emptyTrash();
    else if (act === 'sort') menu([{ header: 'Sort by' }, ...['name', 'date', 'size', 'type'].map(k => ({ label: ({ name: 'Name', date: 'Date modified', size: 'Size', type: 'Kind' })[k] + (sort.key === k ? (sort.dir === 'asc' ? '  ↑' : '  ↓') : ''), ic: sort.key === k ? 'check' : 'sort', run: () => { sort = { key: k, dir: sort.key === k && sort.dir === 'asc' ? 'desc' : 'asc' }; lsSet('nx.sort', JSON.stringify(sort)); renderFiles(root, ctx.route); } }))], a);
  });
}

function wireItems(box, d) {
  const idOf = t => { const n = t.closest('[data-id]'); return n && n.dataset.id; };
  box.addEventListener('click', e => {
    const id = idOf(e.target); if (!id) return;
    if (e.target.closest('[data-more]')) { e.stopPropagation(); return itemMenu(id, e.target.closest('[data-more]')); }
    if (e.target.closest('[data-check]') || e.ctrlKey || e.metaKey) { toggle(id); anchor = id; return; }
    if (e.shiftKey && anchor) { rangeTo(id); return; }
    if (prefs.get('openWith') === 'double') {   // desktop style: a click selects just this item…
      if (e.detail < 2) { sel.clear(); sel.add(id); anchor = id; reflectSel(); }
      return;
    }
    if (sel.size) { toggle(id); anchor = id; return; }   // while selecting, clicks add/remove
    open(id);
  });
  box.addEventListener('dblclick', e => {   // …double-click opens
    if (prefs.get('openWith') !== 'double') return;
    const id = idOf(e.target); if (!id || e.target.closest('[data-more],[data-check]')) return;
    sel.clear(); reflectSel(); open(id);
  });
  box.addEventListener('keydown', e => {
    const id = idOf(e.target); if (!id) return;
    if (e.key === 'Enter') { e.preventDefault(); open(id); }
    else if (e.key === ' ') { e.preventDefault(); toggle(id); }
  });
  box.addEventListener('contextmenu', e => {
    const id = idOf(e.target); if (!id) return;
    e.preventDefault(); e.stopPropagation();
    if (sel.size > 1 && sel.has(id)) selectionMenu({ x: e.clientX, y: e.clientY });
    else itemMenu(id, { x: e.clientX, y: e.clientY });
  });
  // long-press selects on touch
  let lp = null;
  box.addEventListener('pointerdown', e => { if (e.pointerType !== 'touch') return; const id = idOf(e.target); if (!id) return; lp = setTimeout(() => { toggle(id); anchor = id; lp = 'fired'; navigator.vibrate && navigator.vibrate(10); }, 450); });
  box.addEventListener('pointerup', e => { if (lp === 'fired') { e.preventDefault(); } clearTimeout(lp); lp = null; });
  box.addEventListener('pointermove', () => { if (lp && lp !== 'fired') { clearTimeout(lp); lp = null; } });
}

/* drag items onto folders (cards, rows, breadcrumbs) to move them */
function wireDrag(root) {
  root.addEventListener('dragstart', e => {
    const n = e.target.closest('[data-id]'); if (!n) return;
    const id = n.dataset.id;
    const ids = sel.has(id) ? [...sel] : [id];
    e.dataTransfer.setData('application/x-simplex-ids', JSON.stringify(ids));
    e.dataTransfer.effectAllowed = 'move';
    const g = el(html`<div style="position:fixed;top:-100px;left:-100px;padding:8px 14px;border-radius:999px;background:#8b7cff;color:#0b0b12;font:600 13px Inter,sans-serif">${ids.length > 1 ? `Moving ${ids.length} items` : store.byId(id).name}</div>`.s);
    document.body.appendChild(g); e.dataTransfer.setDragImage(g, 20, 16); setTimeout(() => g.remove(), 0);
  });
  root.addEventListener('dragover', e => {
    if (!e.dataTransfer.types.includes('application/x-simplex-ids')) return;
    const t = e.target.closest('[data-drop]'); if (!t) return;
    e.preventDefault(); e.dataTransfer.dropEffect = 'move';
    $$('.drop-hl', root).forEach(x => x !== t && x.classList.remove('drop-hl'));
    t.classList.add('drop-hl'); t.style.boxShadow = 'inset 0 0 0 2px var(--acc), 0 0 30px -6px var(--acc)';
  });
  root.addEventListener('dragleave', e => { const t = e.target.closest('[data-drop]'); if (t && !t.contains(e.relatedTarget)) { t.classList.remove('drop-hl'); t.style.boxShadow = ''; } });
  root.addEventListener('drop', async e => {
    const raw = e.dataTransfer.getData('application/x-simplex-ids'); if (!raw) return;
    const t = e.target.closest('[data-drop]'); if (!t) return;
    e.preventDefault(); e.stopPropagation();
    t.classList.remove('drop-hl'); t.style.boxShadow = '';
    const dest = t.dataset.drop || null;
    const ids = JSON.parse(raw).filter(i => i !== dest);
    if (ids.length) doMove(ids, dest);
  });
}

function toggle(id) { sel.has(id) ? sel.delete(id) : sel.add(id); reflectSel(); }
function rangeTo(id) {
  const ids = ctx.items.map(f => f.id); const a = ids.indexOf(anchor), b = ids.indexOf(id);
  if (a < 0 || b < 0) return toggle(id);
  ids.slice(Math.min(a, b), Math.max(a, b) + 1).forEach(i => sel.add(i)); reflectSel();
}
export function selectAll() { if (!ctx) return; ctx.items.forEach(f => sel.add(f.id)); reflectSel(); }
export function clearSel() { if (!sel.size) return false; sel.clear(); reflectSel(); return true; }
function reflectSel() {
  if (!ctx) return;
  $$('[data-id]', ctx.root).forEach(n => n.classList.toggle('sel', sel.has(n.dataset.id)));
  ctx.root.querySelector('.fbody') && ctx.root.querySelector('.fbody').firstElementChild && ctx.root.querySelector('.fbody').firstElementChild.classList.toggle('selecting', sel.size > 0);
  syncSelbar();
}

/* ---------- selection bar ---------- */
let bar = null;
function syncSelbar() {
  const n = sel.size;
  if (!n || !ctx) { if (bar) { const b = bar; bar = null; animate(b, [{ opacity: 1 }, { opacity: 0, transform: 'translateX(-50%) translateY(12px) scale(0.95)' }], { duration: 180, fill: 'forwards' }).then(() => b.remove()); } return; }
  const trash = ctx.d.trash;
  const markup = html`<div class="selbar" role="toolbar">
    <button class="ib sm" data-sa="clear" aria-label="Clear selection">${icon('close', 16)}</button>
    <span class="n">${n} selected</span>
    ${trash ? html`<button class="b sm" data-sa="restore">${icon('restore', 15)} Restore</button><button class="b sm danger" data-sa="destroy">${icon('trash', 15)} Delete forever</button>`
      : html`<button class="b sm flat" data-sa="all">Select all</button><button class="b sm" data-sa="star">${icon('star', 15)} Star</button><button class="b sm" data-sa="move">${icon('move', 15)} Move</button><button class="b sm" data-sa="download">${icon('download', 15)} Download</button><button class="b sm danger" data-sa="trash">${icon('trash', 15)} Trash</button>`}
  </div>`.s;
  if (!bar) { bar = el(markup); document.body.appendChild(bar); bar.addEventListener('click', onSelbar); }
  else { const fresh = el(markup); bar.innerHTML = fresh.innerHTML; }
}
async function onSelbar(e) {
  const b = e.target.closest('[data-sa]'); if (!b) return;
  const ids = [...sel], a = b.dataset.sa;
  if (a === 'clear') return clearSel();
  if (a === 'all') return selectAll();
  if (a === 'star') { const on = !ids.every(i => store.byId(i) && store.byId(i).starred); await Promise.all(ids.map(i => store.setStar(i, on))); toast(on ? `Starred ${plural(ids.length, 'item')}` : 'Removed stars', { ic: 'star' }); return; }
  if (a === 'move') return moveDialog(ids);
  if (a === 'download') { ids.forEach(i => queueDownload(i)); return; }
  if (a === 'trash') return doTrash(ids);
  if (a === 'restore') { await store.restore(ids); sel.clear(); toast(`Restored ${plural(ids.length, 'item')}`, { ic: 'restore' }); return; }
  if (a === 'destroy') return doDestroy(ids);
}

/* ---------- actions ---------- */
export function open(id) {
  const f = store.byId(id); if (!f) return;
  if (f.trashed) return itemMenu(id, document.querySelector(`[data-id="${CSS.escape(id)}"] [data-more]`) || { x: innerWidth / 2, y: innerHeight / 2 });
  if (f.type === 'folder') return go(hrefFolder(f.id));
  // a .gguf language model opens in the Model Lab instead of a (binary) text viewer
  if (isLabModel(f)) return openLab([id], { kind: 'chat' });
  const list = ctx ? ctx.items.filter(x => x.type !== 'folder') : [f];
  openViewer(f, list);
}
function itemMenu(id, at) { const items = itemMenuItems(id); if (items.length) menu(items, at); }
/* the one menu for a vault item — files.js, Home and the palette all use it */
export function itemMenuItems(id) {
  const f = store.byId(id); if (!f) return [];
  if (f.trashed) return [
    { label: 'Restore', ic: 'restore', run: async () => { await store.restore([id]); toast('Restored', { ic: 'restore' }); } },
    { label: 'Delete forever', ic: 'trash', danger: true, run: () => doDestroy([id]) },
  ];
  const isFile = f.type !== 'folder';
  return [
    { label: isFile ? 'Open' : 'Open folder', ic: isFile ? 'eye' : 'folder', run: () => open(id) },
    isFile && { label: 'Download', ic: 'download', run: () => queueDownload(id) },
    canAiEdit(f) && { label: 'AI Edit…', ic: 'spark', run: () => aiEditDialog(id) },
    canConvert(f) && { label: 'Convert…', ic: 'swap', run: () => convertDialog(id) },
    f.type === 'video' && { label: 'Add to a series…', ic: 'video', run: () => import('./series.js').then(m => m.addToSeriesDialog([id])) },
    ...labItems(f),
    ...vmItems(f),
    '-',
    { label: 'Rename', ic: 'pencil', key: 'F2', run: () => renameItem(id) },
    { label: 'Move to…', ic: 'move', run: () => moveDialog([id]) },
    { label: f.starred ? 'Remove star' : 'Star', ic: 'star', run: () => store.setStar(id, !f.starred).then(() => toast(f.starred ? 'Starred' : 'Star removed', { ic: 'star' })) },
    { label: 'Details', ic: 'info', run: () => details(id) },
    !ctx || ctx.route.name !== 'files' ? { label: 'Show in folder', ic: 'folder', run: () => go(hrefFolder(f.parent || null)) } : null,
    '-',
    { label: 'Move to Trash', ic: 'trash', danger: true, key: 'Del', run: () => doTrash([id]) },
  ].filter(x => x !== false && x != null);
}
/* Model Lab: raw GGUF inference with no system prompt (separate from the AI app) */
function isLabModel(f) {
  const a = store.S.account;
  return !!(f && f.type !== 'folder' && !f.trashed && !f.locked && /\.(gguf|guff)$/i.test(f.name || '') && a && (a.is_admin || a.can_ai));
}
function openLab(ids, opts) {
  import('./modellab.js').then(m => m.openModelLab({ ...opts, ids: ids.map(i => String(i).startsWith('local:') ? i : 'local:user:' + i) }))
    .catch(() => toast('Model Lab failed to load', { bad: true }));
}
function labItems(f) {
  if (!isLabModel(f)) return [];
  return ['-', { header: 'Model Lab · no system prompt' },
    { label: 'Chat with model', ic: 'chat', run: () => openLab([f.id], { kind: 'chat' }) },
    { label: 'Raw inference & token stepper', ic: 'chart', run: () => openLab([f.id], { kind: 'raw' }) },
    { label: 'Compare with other models', ic: 'apps', run: () => openLab([f.id], { mode: 'compare' }) }, '-'];
}
/* Virtual machines: programs can run in one, anything can be sent into one */
function vmItems(f) {
  const a = store.S.account;
  if (f.type === 'folder' || !f.url || f.locked || !(a && (a.is_admin || a.can_vm))) return [];
  const runnable = /\.(exe|msi|bat|cmd|com|scr|jar|ps1)$/i.test(f.name);
  return [
    runnable && { label: 'Run in a virtual machine', ic: 'desktop', run: () => go('#/vms/run:' + f.id) },
    { label: 'Send to a virtual machine', ic: 'desktop', run: () => go('#/vms/send:' + f.id) },
  ].filter(Boolean);
}
/* right-click on empty space in a listing */
function backgroundMenu(at) {
  if (!ctx) return;
  const d = ctx.d;
  menu([
    d.canCreate && { label: 'New folder', ic: 'newfolder', run: () => newFolder(d.folder) },
    d.canCreate && { label: 'Upload files', ic: 'upload', run: () => pickAndUpload(d.folder) },
    d.canCreate && '-',
    ctx.items.length && { label: 'Select all', ic: 'check', key: 'Ctrl A', run: selectAll },
    { label: view() === 'grid' ? 'Show as list' : 'Show as grid', ic: view() === 'grid' ? 'list' : 'grid', run: () => prefs.set({ view: view() === 'grid' ? 'list' : 'grid' }) },
    { header: 'Sort by' },
    ...['name', 'date', 'size', 'type'].map(k => ({ label: ({ name: 'Name', date: 'Date modified', size: 'Size', type: 'Kind' })[k] + (sort.key === k ? (sort.dir === 'asc' ? '  ↑' : '  ↓') : ''), ic: sort.key === k ? 'check' : 'sort', run: () => { sort = { key: k, dir: sort.key === k && sort.dir === 'asc' ? 'desc' : 'asc' }; lsSet('nx.sort', JSON.stringify(sort)); renderFiles(ctx.root.parentElement, ctx.route); } })),
    d.trash && ctx.items.length && '-',
    d.trash && ctx.items.length && { label: 'Empty Trash', ic: 'trash', danger: true, run: emptyTrash },
  ].filter(Boolean), at);
}
function selectionMenu(at) {
  const ids = [...sel];
  menu([{ header: `${ids.length} selected` },
    { label: 'Move to…', ic: 'move', run: () => moveDialog(ids) },
    { label: 'Star all', ic: 'star', run: () => Promise.all(ids.map(i => store.setStar(i, true))) },
    { label: 'Download', ic: 'download', run: () => ids.forEach(i => queueDownload(i)) },
    ids.some(i => (store.byId(i) || {}).type === 'video') && { label: 'Add videos to a series…', ic: 'video', run: () => import('./series.js').then(m => m.addToSeriesDialog(ids)) },
    ids.filter(i => isLabModel(store.byId(i))).length >= 2 && { label: `Compare ${Math.min(4, ids.filter(i => isLabModel(store.byId(i))).length)} models in Model Lab`, ic: 'apps', run: () => openLab(ids.filter(i => isLabModel(store.byId(i))).slice(0, 4), { mode: 'compare' }) },
    '-', { label: 'Move to Trash', ic: 'trash', danger: true, run: () => doTrash(ids) }], at);
}
export async function newFolder(parent) {
  const name = await prompt({ title: 'New folder', ic: 'newfolder', value: 'Untitled folder', ok: 'Create', select: 'all' });
  if (!name) return;
  try { const f = await store.createFolder(name, parent); toast('Folder created', { ic: 'folder' }); flash(f.id); }
  catch (e) { toast(e.message, { bad: true }); }
}
export async function renameItem(id) {
  const f = store.byId(id); if (!f) return;
  const name = await prompt({ title: 'Rename', value: f.name, select: f.type === 'folder' ? 'all' : 'base' });
  if (!name || name === f.name) return;
  try { await store.rename(id, name); toast('Renamed', { ic: 'pencil' }); flash(id); }
  catch (e) { toast(e.message, { bad: true }); }
}
async function doTrash(ids) {
  try {
    await store.trash(ids); sel.clear(); syncSelbar();
    toast(ids.length > 1 ? `Moved ${ids.length} items to Trash` : 'Moved to Trash', { ic: 'trash', action: 'Undo', onAction: async () => { await store.restore(ids); toast('Restored', { ic: 'restore' }); } });
  } catch (e) { toast(e.message, { bad: true }); }
}
async function doDestroy(ids) {
  const ok = await confirm({ title: ids.length > 1 ? `Delete ${ids.length} items forever?` : 'Delete forever?', text: 'This can’t be undone. Folders take everything inside them with them.', ok: 'Delete forever', danger: true, ic: 'trash', tint: 't-video' });
  if (!ok) return;
  try { await store.destroy(ids); sel.clear(); syncSelbar(); toast('Deleted', { ic: 'trash' }); }
  catch (e) { toast(e.message, { bad: true }); }
}
async function emptyTrash() {
  const ok = await confirm({ title: 'Empty Trash?', text: 'Everything in Trash is deleted forever. This can’t be undone.', ok: 'Empty Trash', danger: true, ic: 'trash', tint: 't-video' });
  if (!ok) return;
  try { await store.emptyTrash(); toast('Trash emptied', { ic: 'trash' }); } catch (e) { toast(e.message, { bad: true }); }
}
async function doMove(ids, dest) {
  try {
    const r = await store.move(ids, dest);
    sel.clear(); syncSelbar();
    const to = dest ? store.byId(dest).name : 'All files';
    toast(r.skipped && r.skipped.length ? `Moved ${r.moved.length}; ${r.skipped.length} couldn’t go there` : `Moved to ${to}`, { ic: 'move', action: 'Open', onAction: () => go(hrefFolder(dest)) });
  } catch (e) { toast(e.message, { bad: true }); }
}
function moveDialog(ids) {
  // folder tree, excluding the moved folders themselves and everything inside them
  const banned = new Set(ids);
  ids.forEach(i => store.descendants(i).forEach(f => banned.add(f.id)));
  const folders = store.live().filter(f => f.type === 'folder' && !banned.has(f.id));
  const kids = p => folders.filter(f => (f.parent ?? null) === p).sort((a, b) => a.name.localeCompare(b.name));
  const rows = (p, depth) => kids(p).map(f => html`<button data-dest="${f.id}" style="padding-left:${10 + depth * 18}px">${icon('folder', 16)}<span>${f.name}</span></button>${rows(f.id, depth + 1)}`);
  let dest = null;
  dialog({
    title: ids.length > 1 ? `Move ${ids.length} items` : `Move “${store.byId(ids[0]).name}”`, ic: 'move', tint: 't-folder',
    body: html`<div class="tree"><button data-dest="" class="on">${icon('home', 16)}<span>All files</span></button>${rows(null, 1)}</div>`,
    actions: [{ label: 'Cancel' }, { label: 'Move here', kind: 'pri', run: () => doMove(ids, dest) }],
    onMount: r => r.querySelector('.tree').addEventListener('click', e => {
      const b = e.target.closest('[data-dest]'); if (!b) return;
      $$('[data-dest]', r).forEach(x => x.classList.toggle('on', x === b)); dest = b.dataset.dest || null;
    }),
  });
}
export const download = id => queueDownload(id);
export function details(id) {
  const f = store.byId(id); if (!f) return;
  const rows = [['Kind', f.type === 'folder' ? 'Folder' : (ext(f.name) || f.type).toUpperCase() + ' ' + f.type]];
  if (f.type === 'folder') { const d = store.descendants(f.id).filter(x => !x.trashed); rows.push(['Contains', plural(d.filter(x => x.type !== 'folder').length, 'file') + ', ' + plural(d.filter(x => x.type === 'folder').length, 'folder')]); rows.push(['Size', fmtSize(d.reduce((n, x) => n + (x.type === 'folder' ? 0 : x.size || 0), 0))]); }
  else rows.push(['Size', fmtSize(f.size)]);
  if (f.w && f.h) rows.push(['Dimensions', `${f.w} × ${f.h}`]);
  if (f.dur) rows.push(['Duration', fmtDur(f.dur)]);
  if (f.artist) rows.push(['Artist', f.artist]);
  if (f.album) rows.push(['Album', f.album]);
  rows.push(['Location', store.pathOf(f.id).slice(0, -1).map(x => x.name).join(' / ') || 'All files']);
  rows.push(['Modified', f.date ? new Date(f.date).toLocaleString() : '—']);
  if (f.locked) rows.push(['Protection', 'Locked']);
  dialog({ title: f.name, ic: f.type === 'folder' ? 'folder' : f.type, tint: 't-' + f.type, body: html`<dl class="kv">${rows.map(([k, v]) => html`<div><dt>${k}</dt><dd>${v}</dd></div>`)}</dl>`, actions: [{ label: 'Done', kind: 'pri' }] });
}
/* briefly highlight a newly created/renamed item once it renders */
function flash(id) {
  setTimeout(() => { const n = document.querySelector(`[data-id="${CSS.escape(id)}"]`); if (!n) return; n.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); animate(n, [{ boxShadow: '0 0 0 3px var(--acc), 0 0 40px var(--acc)' }, { boxShadow: '0 0 0 0 transparent' }], { duration: 1200, easing: 'ease-out' }); }, 60);
}

/* keyboard shortcuts while a listing is open (main.js routes keys here) */
export function onKey(e) {
  if (!ctx || !ctx.root.isConnected) return false;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') { e.preventDefault(); selectAll(); return true; }
  if (e.key === 'Escape') return clearSel();
  if ((e.key === 'Delete' || e.key === 'Backspace') && sel.size && !ctx.d.trash) { e.preventDefault(); doTrash([...sel]); return true; }
  if (e.key === 'F2' && sel.size === 1) { e.preventDefault(); renameItem([...sel][0]); return true; }
  return false;
}
/* IntersectionObservers keep their targets (and so the whole old page) alive until
   disconnected; without this every folder visit leaked its DOM and listeners. */
let observers = [];
function dropObservers() { observers.forEach(o => { try { o.disconnect(); } catch (e) {} }); observers = []; }
export function leave() { dropObservers(); if (ctx && ctx.root) cancelThumbs(ctx.root); sel.clear(); syncSelbar(); ctx = null; }
export function currentFolder() { return ctx && ctx.route.name === 'files' ? (ctx.route.arg || null) : null; }
