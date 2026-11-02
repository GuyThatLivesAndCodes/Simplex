/* tasks.js — one queue for everything that takes a while: uploads, downloads,
   conversions, AI image edits. Each kind runs in its own lane with a concurrency
   limit (the server allows ONE conversion per account at a time, so that lane is
   1). Queued work can be reordered, cancelled, retried; finished work stays in
   the list (with an Open button) until cleared.

   A task supplies run(task, { signal, progress(fraction|null, detail) }) and
   resolves with a result (usually a vault row). Lanes pull the first queued task
   in list order, so reordering the list reorders the work. */
import { html, el, icon, animate, SPRING, SMOOTH, $$, plural } from './lib.js';
import { toast } from './ui.js';

const LANES = { upload: 1, download: 2, convert: 1, aiedit: 1, ai: 3 };   // ai: chat replies, three at once
const KIND = {
  upload: { label: 'Upload', ic: 'upload' },
  download: { label: 'Download', ic: 'download' },
  convert: { label: 'Convert', ic: 'swap' },
  aiedit: { label: 'AI edit', ic: 'spark' },
  ai: { label: 'AI chat', ic: 'chat' },
};
let tasks = [];
let seq = 0;
const subs = new Set();
export const onTasks = fn => { subs.add(fn); return () => subs.delete(fn); };
const notify = () => { subs.forEach(fn => { try { fn(tasks); } catch (e) {} }); paint(); };

export function addTask({ kind, title, sub = '', tint, run, cancelRunning = true, open, meta }) {
  const t = { id: 't' + (++seq), kind, title, sub, tint: tint || 't-app', run, cancelRunning, open, meta: meta || {}, state: 'queued', progress: null, detail: '', created: Date.now() };
  tasks.push(t);
  notify();
  pump();
  pulseFab();
  return t;
}
export const allTasks = () => tasks;
export const active = () => tasks.filter(t => t.state === 'queued' || t.state === 'running');

function pump() {
  for (const lane in LANES) {
    const running = tasks.filter(t => t.kind === lane && t.state === 'running').length;
    let free = LANES[lane] - running;
    for (const t of tasks) {
      if (free <= 0) break;
      if (t.kind === lane && t.state === 'queued') { start(t); free--; }
    }
  }
}

async function start(t) {
  t.state = 'running'; t.started = Date.now(); t.ctl = new AbortController();
  notify();
  try {
    t.result = await t.run(t, {
      signal: t.ctl.signal,
      progress: (p, detail) => { t.progress = p == null ? null : Math.max(0, Math.min(1, p)); if (detail != null) t.detail = detail; paintTask(t); },
    });
    if (t.state === 'cancelled') return;
    t.state = 'done'; t.progress = 1; t.detail = t.doneText || 'Done';
  } catch (e) {
    if (t.state === 'cancelled' || (e && (e.name === 'AbortError' || e.code === 'ABORT'))) { t.state = 'cancelled'; t.detail = 'Cancelled'; }
    else { t.state = 'failed'; t.detail = (e && e.message) || 'Failed'; }
  } finally {
    t.finished = Date.now();
    notify();
    pump();
    if (!active().length) settle();
  }
}

export function cancelTask(id) {
  const t = tasks.find(x => x.id === id); if (!t) return;
  if (t.state === 'queued') { t.state = 'cancelled'; t.detail = 'Cancelled'; notify(); pump(); }
  else if (t.state === 'running') {
    if (!t.cancelRunning) return toast('This one can’t be stopped once it has started', { bad: true });
    t.state = 'cancelled'; t.detail = 'Cancelled';
    try { t.ctl.abort(); } catch (e) {}
    notify();
  }
}
export function retryTask(id) {
  const t = tasks.find(x => x.id === id); if (!t || !['failed', 'cancelled'].includes(t.state)) return;
  t.state = 'queued'; t.progress = null; t.detail = ''; notify(); pump();
}
/* move a queued task up/down among the tasks of its kind */
export function moveTask(id, dir) {
  const i = tasks.findIndex(x => x.id === id); if (i < 0 || tasks[i].state !== 'queued') return;
  let j = i + dir;
  while (j >= 0 && j < tasks.length && tasks[j].state !== 'queued') j += dir;
  if (j < 0 || j >= tasks.length) return;
  const [t] = tasks.splice(i, 1); tasks.splice(j, 0, t); notify();
}
/* drag-to-reorder: place `id` before `beforeId` (or at the end of the queue) */
function placeTask(id, beforeId) {
  const i = tasks.findIndex(x => x.id === id); if (i < 0) return;
  const [t] = tasks.splice(i, 1);
  const j = beforeId ? tasks.findIndex(x => x.id === beforeId) : tasks.length;
  tasks.splice(j < 0 ? tasks.length : j, 0, t); notify();
}
export function clearFinished() { tasks = tasks.filter(t => t.state === 'queued' || t.state === 'running'); notify(); }

/* ---------------- UI: Activity button + panel ---------------- */
let fab = null, panel = null, open = false;

function ensureUi() {
  if (fab) return;
  fab = el(html`<button class="act-fab" aria-label="Activity" hidden>
    <svg class="act-ring" viewBox="0 0 36 36" aria-hidden="true"><circle cx="18" cy="18" r="15.5" class="tr"/><circle cx="18" cy="18" r="15.5" class="va"/></svg>
    <span class="act-ic">${icon('swap', 16)}</span><span class="act-n"></span></button>`.s);
  fab.onclick = () => toggle();
  document.body.appendChild(fab);
}
export function toggle(force) {
  ensureUi();
  open = force == null ? !open : force;
  if (open && !panel) {
    panel = el(`<section class="act-panel" role="dialog" aria-label="Activity"></section>`);
    document.body.appendChild(panel);
    wirePanel(panel);
    animate(panel, [{ opacity: 0, transform: 'translateY(14px) scale(0.96)' }, { opacity: 1, transform: 'none' }], { duration: 420, easing: SPRING });
    const away = e => { if (!open) return document.removeEventListener('pointerdown', away, true); if (panel && !panel.contains(e.target) && !fab.contains(e.target)) toggle(false); };
    setTimeout(() => document.addEventListener('pointerdown', away, true), 0);
  } else if (!open && panel) {
    const p = panel; panel = null;
    animate(p, [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(10px) scale(0.97)' }], { duration: 180, fill: 'forwards', easing: SMOOTH }).then(() => p.remove());
  }
  paint();
}
function pulseFab() { ensureUi(); paint(); if (!fab.hidden) animate(fab, [{ transform: 'scale(1)' }, { transform: 'scale(1.18)' }, { transform: 'scale(1)' }], { duration: 500, easing: SPRING }); }
/* when everything is finished, the button lingers briefly then tucks away (if the panel is closed) */
let settleTimer = null;
function settle() { clearTimeout(settleTimer); settleTimer = setTimeout(() => { if (!active().length && !open) paint(); }, 4000); }

function paint() {
  ensureUi();
  const act = active(), done = tasks.filter(t => t.state === 'done' && Date.now() - t.finished < 5000);
  const show = act.length > 0 || open || done.length > 0 || tasks.some(t => t.state === 'failed');
  fab.hidden = !show;
  const n = act.length;
  fab.querySelector('.act-n').textContent = n ? String(n) : tasks.some(t => t.state === 'failed') ? '!' : '✓';
  fab.classList.toggle('busy', n > 0);
  fab.classList.toggle('bad', !n && tasks.some(t => t.state === 'failed'));
  // overall progress = mean of running tasks with known progress
  const known = act.filter(t => t.state === 'running' && t.progress != null);
  const p = known.length ? known.reduce((s, t) => s + t.progress, 0) / known.length : (n ? 0 : 1);
  fab.querySelector('.va').style.strokeDashoffset = String(97.4 * (1 - p));
  if (panel) paintPanel();
}
function paintTask(t) {
  if (!panel) { paint(); return; }
  const row = panel.querySelector(`[data-t="${t.id}"]`);
  if (!row) return paintPanel();
  const bar = row.querySelector('.tk-bar i');
  if (bar) { bar.style.width = t.progress == null ? '' : (t.progress * 100).toFixed(1) + '%'; bar.parentElement.classList.toggle('ind', t.progress == null); }
  const d = row.querySelector('.tk-d'); if (d) d.textContent = detailText(t);
  paintRingOnly();
}
function paintRingOnly() {
  const act = active(); const known = act.filter(t => t.state === 'running' && t.progress != null);
  const p = known.length ? known.reduce((s, t) => s + t.progress, 0) / known.length : 0;
  if (fab) fab.querySelector('.va').style.strokeDashoffset = String(97.4 * (1 - p));
}
const detailText = t => t.state === 'running' ? (t.detail || 'Working…') + (t.progress != null ? ` · ${Math.round(t.progress * 100)}%` : '')
  : t.state === 'queued' ? 'Waiting…' : t.detail || t.state;

function rowHTML(t, i, queuedCount) {
  const k = KIND[t.kind] || KIND.upload;
  const canMove = t.state === 'queued';
  return html`<div class="tk ${t.state}" data-t="${t.id}" ${canMove ? 'draggable="true"' : ''}>
    ${canMove ? html`<span class="tk-grip" title="Drag to reorder">⋮⋮</span>` : ''}
    <span class="tk-ic tint ${t.tint}">${icon(t.state === 'done' ? 'check' : t.state === 'failed' ? 'info' : k.ic, 15)}</span>
    <div class="tk-m"><div class="tk-t" title="${t.title}">${t.title}</div><div class="tk-d">${detailText(t)}</div>
      ${t.state === 'running' ? html`<div class="tk-bar${t.progress == null ? ' ind' : ''}"><i style="width:${t.progress == null ? 0 : t.progress * 100}%"></i></div>` : ''}</div>
    <div class="tk-a">
      ${canMove ? html`<button class="ib sm" data-a="up" aria-label="Move up">${icon('arrowup', 14)}</button><button class="ib sm" data-a="down" aria-label="Move down">${icon('arrowdown', 14)}</button>` : ''}
      ${t.open && (t.state === 'done' || t.kind === 'ai') ? html`<button class="b sm" data-a="open">Open</button>` : ''}
      ${['failed', 'cancelled'].includes(t.state) ? html`<button class="ib sm" data-a="retry" aria-label="Retry">${icon('restore', 15)}</button>` : ''}
      ${['queued', 'running'].includes(t.state) ? html`<button class="ib sm" data-a="cancel" aria-label="Cancel" ${t.state === 'running' && !t.cancelRunning ? 'disabled title="Can’t stop once started"' : ''}>${icon('close', 15)}</button>` : ''}
    </div></div>`;
}
function paintPanel() {
  const running = tasks.filter(t => t.state === 'running'), queued = tasks.filter(t => t.state === 'queued');
  const finished = tasks.filter(t => !['running', 'queued'].includes(t.state)).slice().reverse();
  const sec = (title, list, extra = '') => list.length ? html`<div class="tk-sec"><div class="tk-h"><span>${title}</span>${extra}</div>${list.map((t, i) => rowHTML(t, i, queued.length))}</div>` : '';
  panel.innerHTML = html`<header class="act-head"><b>Activity</b><span class="dim">${active().length ? plural(active().length, 'task') + ' in progress' : 'All done'}</span>
      <button class="ib sm" data-a="close" aria-label="Close">${icon('close', 16)}</button></header>
    <div class="act-body">
      ${tasks.length ? '' : html`<div class="act-empty">${icon('check', 22)}<span>Uploads, downloads, conversions, AI edits and AI chats show up here.</span></div>`}
      ${sec('Running', running)}
      ${sec('Up next', queued, queued.length > 1 ? html`<small class="dim">drag to reorder</small>` : '')}
      ${sec('Finished', finished, html`<button class="link" data-a="clear">Clear</button>`)}
    </div>`.s;
}
function wirePanel(p) {
  p.addEventListener('click', e => {
    const b = e.target.closest('[data-a]'); if (!b) return;
    const a = b.dataset.a, row = b.closest('[data-t]'), id = row && row.dataset.t;
    if (a === 'close') return toggle(false);
    if (a === 'clear') return clearFinished();
    if (a === 'cancel') cancelTask(id);
    else if (a === 'retry') retryTask(id);
    else if (a === 'up') moveTask(id, -1);
    else if (a === 'down') moveTask(id, 1);
    else if (a === 'open') { const t = tasks.find(x => x.id === id); t && t.open && t.open(t.result); toggle(false); }
  });
  // drag to reorder queued tasks
  let dragId = null;
  p.addEventListener('dragstart', e => { const r = e.target.closest('.tk.queued'); if (!r) return; dragId = r.dataset.t; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', dragId); r.classList.add('dragging'); });
  p.addEventListener('dragend', () => { dragId = null; $$('.tk', p).forEach(r => r.classList.remove('dragging', 'drop-before')); });
  p.addEventListener('dragover', e => {
    if (!dragId) return; const r = e.target.closest('.tk.queued'); e.preventDefault();
    $$('.tk', p).forEach(x => x.classList.toggle('drop-before', x === r && r.dataset.t !== dragId));
  });
  p.addEventListener('drop', e => {
    if (!dragId) return; e.preventDefault();
    const r = e.target.closest('.tk.queued');
    placeTask(dragId, r && r.dataset.t !== dragId ? r.dataset.t : null);
  });
}

/* leaving the page with work in flight would lose it */
window.addEventListener('beforeunload', e => { if (active().some(t => ['upload', 'download', 'convert', 'ai'].includes(t.kind))) { e.preventDefault(); e.returnValue = ''; } });
