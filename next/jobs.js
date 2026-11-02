/* jobs.js — user actions that become queued tasks: downloads, conversions and
   AI image edits. Each builds a task for tasks.js; the queue does the rest. */
import { html, raw, el, icon, esc, fmtSize, ext, plural, api, lsGet, lsSet } from './lib.js';
import * as store from './store.js';
import { toast, dialog, confirm, seg } from './ui.js';
import { addTask, toggle as toggleActivity } from './tasks.js';
import { conversionsFor } from './formats.js';
import { ensureTos } from './upload.js';

const openFile = row => row && import('./viewer.js').then(v => { const f = store.byId(row.id) || row; v.openViewer(f, [f]); });
const STREAM_MAX = 512 * 1024 * 1024;   // above this the browser downloads it natively (no RAM copy)

/* ---------------- downloads ---------------- */
export function queueDownload(id) {
  const f = store.byId(id); if (!f || f.type === 'folder') return;
  if (f.locked) return toast('Locked files download from the classic interface for now', { bad: true });
  if (f.kv === 1) return toast('This file uses the old encryption key — re-encrypt it in Classic first', { bad: true });
  addTask({
    kind: 'download', title: f.name, sub: fmtSize(f.size), tint: 't-' + f.type,
    run: (t, ctx) => runDownload(f, ctx),
  });
}
async function runDownload(f, { signal, progress }) {
  if (!f.url) {   // content-backed text document: build the file locally
    progress(null, 'Preparing');
    const text = await store.fetchText(f);
    saveBlob(new Blob([text], { type: 'text/plain' }), f.name);
    return null;
  }
  const url = f.url + (f.url.includes('?') ? '&' : '?') + 'dl=1';
  if ((f.size || 0) > STREAM_MAX) {
    // too big to hold in memory: hand it to the browser's own downloader
    const a = document.createElement('a'); a.href = url; a.download = f.name; document.body.appendChild(a); a.click(); a.remove();
    return null;
  }
  const res = await fetch(url, { credentials: 'same-origin', signal });
  if (!res.ok) { let m = `Download failed (${res.status})`; try { m = (await res.json()).error || m; } catch (e) {} throw new Error(m); }
  const total = Number(res.headers.get('Content-Length')) || f.size || 0;
  const reader = res.body.getReader(); const parts = []; let got = 0;
  for (;;) {
    const { done, value } = await reader.read(); if (done) break;
    parts.push(value); got += value.length;
    progress(total ? got / total : null, `${fmtSize(got)}${total ? ' of ' + fmtSize(total) : ''}`);
  }
  saveBlob(new Blob(parts, { type: res.headers.get('Content-Type') || 'application/octet-stream' }), f.name);
  return null;
}
function saveBlob(blob, name) { const u = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = u; a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(u), 10000); }

/* ---------------- conversions ---------------- */
export function canConvert(f) { return !!f && f.type !== 'folder' && !!f.url && !f.locked && conversionsFor(f).length > 0; }

/* the format picker; `preset` = a format to preselect (e.g. 'mp4' from the viewer) */
export function convertDialog(id, preset) {
  const f = store.byId(id); if (!canConvert(f)) return toast('This file can’t be converted', { bad: true });
  const groups = conversionsFor(f);
  let pick = groups.flatMap(g => g.targets.map(t => ({ tool: g.tool, t }))).find(x => x.t === preset) || { tool: groups[0].tool, t: groups[0].targets[0] };
  let output = 'save';
  dialog({
    ic: 'swap', tint: 't-' + f.type, title: 'Convert', text: f.name, wide: true,
    body: html`${groups.map(g => html`<div class="cv-g"><span class="eyebrow">${g.group}</span><div class="cv-chips">${g.targets.map(t => html`<button class="cv-chip${pick.t === t && pick.tool === g.tool ? ' on' : ''}" data-tool="${g.tool}" data-fmt="${t}">${t.toUpperCase()}</button>`)}</div></div>`)}
      <div class="cv-g"><span class="eyebrow">Save as</span><div class="seg" data-out><button data-v="save">New file beside it</button><button data-v="replace">Replace the original</button></div></div>
      <p class="dim" style="font-size:12.5px;margin-top:12px">${icon('info', 13)} Conversions run on the server, one at a time — this joins the queue and you can keep working.</p>`,
    actions: [{ label: 'Cancel' }, { label: 'Add to queue', kind: 'pri', run: async () => { if (!(await ensureTos())) return false; queueConvert(f, pick.tool, pick.t, output); } }],
    onMount: r => {
      r.addEventListener('click', e => { const c = e.target.closest('.cv-chip'); if (!c) return; r.querySelectorAll('.cv-chip').forEach(x => x.classList.toggle('on', x === c)); pick = { tool: c.dataset.tool, t: c.dataset.fmt }; });
      seg(r.querySelector('[data-out]'), output, v => { output = v; });
    },
  });
}
export function queueConvert(f, tool, format, output = 'save') {
  addTask({
    kind: 'convert', title: `${f.name.replace(/\.[^.]+$/, '')}.${format}`, sub: `from .${ext(f.name)}`, tint: 't-' + f.type,
    run: (t, ctx) => runConvert(f, tool, format, output, ctx), open: openFile,
  });
  toast(`Converting to ${format.toUpperCase()} — added to the queue`, { ic: 'swap', action: 'View', onAction: () => toggleActivity(true) });
}
async function runConvert(f, tool, format, output, { signal, progress }) {
  progress(null, 'Starting');
  // the server reports progress per account (one conversion at a time), so poll it
  const poll = setInterval(async () => {
    try { const p = await api('/api/tools/progress', { timeout: 5000 }); if (p.active) progress(p.pct == null ? null : p.pct / 100, p.phase === 'saving' ? 'Saving to vault' : 'Converting'); } catch (e) {}
  }, 1200);
  try {
    const r = await api('/api/tools/convert', { method: 'POST', json: { fileId: f.id, tool, format, output }, signal, timeout: 21 * 60000 });
    if (r && r.file) store.added(r.file);
    store.refreshUsage();
    return r && r.file;
  } finally { clearInterval(poll); }
}

/* ---------------- AI image edit ---------------- */
const HIST = 'nx.aiEdits';
export const editHistory = () => { try { return JSON.parse(lsGet(HIST, '[]')) || []; } catch (e) { return []; } };
function saveHistory(list) { lsSet(HIST, JSON.stringify(list.slice(0, 60))); window.dispatchEvent(new CustomEvent('nx:aiedits')); }
const removed = new Set();   // removed while still running: later progress updates must not bring them back
function upsertHistory(entry) { if (removed.has(entry.key)) return; const l = editHistory(); const i = l.findIndex(x => x.key === entry.key); if (i >= 0) l[i] = { ...l[i], ...entry }; else l.unshift(entry); saveHistory(l); }
export function removeEditHistory(key) { removed.add(key); saveHistory(editHistory().filter(x => x.key !== key)); }
export function clearEditHistory() { editHistory().forEach(x => removed.add(x.key)); saveHistory([]); }

export function canAiEdit(f) {
  const a = store.S.account;
  if (!f || f.type !== 'image' || f.locked || !f.url) return false;
  if (!(a && (a.is_admin || a.can_ai))) return false;
  return ['png', 'jpg', 'jpeg'].includes(ext(f.name));
}
const tokens = () => (store.S.account && store.S.account.img_edit) || { unlimited: false, remaining: 0, limit: 5 };
const tokenLine = () => { const t = tokens(); return t.unlimited ? 'Unlimited edits' : `${t.remaining} of ${t.limit} daily edits left`; };

export function aiEditDialog(id, prefill = '') {
  const f = store.byId(id);
  if (!canAiEdit(f)) return toast('AI Edit needs an unlocked PNG or JPEG image', { bad: true });
  const t = tokens();
  if (!t.unlimited && t.remaining < 1) return toast('You’ve used today’s AI edits — they refresh at midnight', { bad: true });
  let quality = 'default';
  dialog({
    ic: 'spark', title: 'AI Edit', text: f.name, wide: true,
    body: html`<div class="ae-prev"><img src="${f.url}" alt=""></div>
      <div class="cv-g"><span class="eyebrow">Quality</span><div class="seg" data-q><button data-v="default">Default · 1 edit</button>${t.unlimited || t.remaining >= 2 ? html`<button data-v="premium">Premium · 2 edits</button>` : ''}</div></div>
      <div class="cv-g"><span class="eyebrow">Describe the edit</span><textarea class="in" rows="3" maxlength="1000" placeholder="e.g. make it night-time with neon lighting">${prefill}</textarea></div>
      <p class="dim ae-tok">${icon('spark', 13)} ${tokenLine()}</p>`,
    actions: [{ label: 'Cancel' }, {
      label: 'Edit image', kind: 'pri', run: async (_c, r) => {
        const prompt = r.querySelector('textarea').value.trim();
        if (!prompt) { r.querySelector('textarea').focus(); return false; }
        const cost = quality === 'premium' ? 2 : 1;
        if (!tokens().unlimited && !(await confirm({ title: `Use ${plural(cost, 'edit')}?`, text: `This ${quality === 'premium' ? 'Premium' : 'Default'} edit uses ${cost} of your ${tokens().remaining} remaining edits today.`, ok: 'Edit image', ic: 'spark' }))) return false;
        if (!(await ensureTos())) return false;
        queueAiEdit(f, prompt, quality);
      },
    }],
    onMount: r => { seg(r.querySelector('[data-q]'), quality, v => { quality = v; }); },
  });
}

export function queueAiEdit(f, prompt, quality) {
  const key = 'e' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  upsertHistory({ key, srcId: f.id, srcName: f.name, srcUrl: f.url, prompt, quality, state: 'queued', created: Date.now() });
  addTask({
    kind: 'aiedit', title: `AI edit · ${f.name}`, sub: prompt, tint: 't-image', cancelRunning: false,
    run: (t, ctx) => runAiEdit(key, f, prompt, quality, ctx), open: openFile,
  });
  toast('AI edit added to the queue', { ic: 'spark', action: 'View', onAction: () => toggleActivity(true) });
}
const PHASE = { starting: 'Starting', reading: 'Reading image', editing: 'Editing with AI', saving: 'Saving to your vault', done: 'Done' };
async function runAiEdit(key, f, prompt, quality, { progress }) {
  progress(null, 'Starting');
  upsertHistory({ key, state: 'running' });
  let job;
  try {
    job = await api('/api/ai/image/edit', { method: 'POST', json: { fileId: f.id, prompt, quality } });
  } catch (e) {
    upsertHistory({ key, state: 'failed', error: e.message });
    throw e;
  }
  if (job.tokens && store.S.account) store.S.account.img_edit = job.tokens;
  upsertHistory({ key, jobId: job.jobId });
  // the job runs on the server even if this tab closes; we just watch it
  for (;;) {
    await new Promise(r => setTimeout(r, 1500));
    let j;
    try { j = await api('/api/ai/image/job/' + job.jobId, { timeout: 10000 }); } catch (e) { if (e.status === 404) { upsertHistory({ key, state: 'failed', error: 'The server lost track of this edit' }); throw new Error('The server lost track of this edit'); } continue; }
    if (j.tokens && store.S.account) store.S.account.img_edit = j.tokens;
    progress(null, PHASE[j.phase] || 'Working');
    if (j.status === 'done') {
      if (j.file) store.added(j.file);
      store.refreshUsage();
      upsertHistory({ key, state: 'done', resultId: j.file && j.file.id, resultName: j.file && j.file.name, resultUrl: j.file && j.file.url });
      toast('AI edit saved', { ic: 'spark', action: 'Open', onAction: () => openFile(j.file) });
      return j.file;
    }
    if (j.status === 'error') { upsertHistory({ key, state: 'failed', error: j.error }); throw new Error(j.error || 'Image edit failed'); }
  }
}
