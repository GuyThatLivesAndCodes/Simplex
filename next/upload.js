/* upload.js — uploads for the new UI. Each file becomes a task in the shared
   queue (tasks.js). Small files go up in one request; anything over the proxy cap
   goes up in parallel chunks (/api/uploads/*), the protocol the classic app uses. */
import { html, el, icon, fmtSize, plural, api } from './lib.js';
import * as store from './store.js';
import { toast, dialog } from './ui.js';
import { addTask, toggle as toggleActivity } from './tasks.js';

const SINGLE_MAX = 90 * 1024 * 1024;   // above this, chunk (Cloudflare caps a request at ~100MB)
const PARALLEL = 4;

export function pickAndUpload(parent) {
  const inp = document.createElement('input');
  inp.type = 'file'; inp.multiple = true;
  inp.onchange = () => { if (inp.files.length) uploadFiles([...inp.files], parent); };
  inp.click();
}

export async function uploadFiles(files, parent) {
  if (!files.length) return;
  if (!(await ensureTos())) return;
  files.forEach(file => addTask({
    kind: 'upload', title: file.name, sub: fmtSize(file.size), tint: 't-' + typeOf(file),
    run: (t, ctx) => runUpload(file, parent ?? null, ctx),
    open: row => row && import('./viewer.js').then(v => v.openViewer(store.byId(row.id) || row, [store.byId(row.id) || row])),
  }));
  toast(`Uploading ${plural(files.length, 'file')}`, { ic: 'upload' });
  toggleActivity(true);
}

/* one file, through the same task queue, resolving with its new row (null if the
   Terms weren't accepted) - for callers that need the result, like attaching a
   subtitle to the video it was uploaded for */
export async function uploadAndWait(file, parent) {
  if (!(await ensureTos())) return null;
  return new Promise((resolve, reject) => addTask({
    kind: 'upload', title: file.name, sub: fmtSize(file.size), tint: 't-' + typeOf(file),
    run: async (t, ctx) => { try { const row = await runUpload(file, parent ?? null, ctx); resolve(row); return row; } catch (e) { reject(e); throw e; } },
  }));
}

async function runUpload(file, parent, { signal, progress }) {
  progress(0, 'Preparing…');
  const meta = await sniff(file);
  const row = file.size > SINGLE_MAX ? await chunked(file, parent, meta, signal, progress) : await single(file, parent, meta, signal, progress);
  store.added(row);
  store.refreshUsage();
  return row;
}

/* the account has to accept the current Terms before adding content to the vault */
export async function ensureTos() {
  if (store.S.account && store.S.account.tos_accepted) return true;
  let tos;
  try { tos = await api('/api/tos'); } catch (e) { toast(e.message, { bad: true }); return false; }
  return new Promise(res => {
    let done = false;
    dialog({
      ic: 'info', title: 'Before you continue', wide: true,
      text: 'Please read and agree to the terms below. They apply to everything you add to your vault.',
      body: html`<div class="tos">${tos.text || ''}</div><label class="check"><input type="checkbox"> I’ve read and agree to the Terms of Service, and I’m responsible for what I add.</label>`,
      actions: [{ label: 'Not now', run: () => { done = true; res(false); } }, {
        label: 'I agree', kind: 'pri', run: async (_c, r) => {
          if (!r.querySelector('.check input').checked) { r.querySelector('.check').animate([{ transform: 'translateX(-4px)' }, { transform: 'translateX(4px)' }, { transform: 'none' }], 240); return false; }
          try { await api('/api/tos/accept', { method: 'POST' }); await store.refreshUsage(); if (store.S.account) store.S.account.tos_accepted = true; done = true; res(true); }
          catch (e) { toast(e.message, { bad: true }); return false; }
        },
      }],
      onMount: r => { const obs = new MutationObserver(() => { if (!r.isConnected) { obs.disconnect(); if (!done) res(false); } }); obs.observe(document.body, { childList: true }); },
    });
  });
}

/* type + duration/dimensions, read locally so the server stores them with the row */
function typeOf(f) { const t = f.type || ''; return t.startsWith('video/') ? 'video' : t.startsWith('audio/') ? 'audio' : t.startsWith('image/') ? 'image' : 'document'; }
function sniff(file) {
  const type = typeOf(file);
  const meta = { type };
  if (type === 'image' && window.createImageBitmap && file.size < 60e6) {
    return createImageBitmap(file).then(b => { meta.w = b.width; meta.h = b.height; b.close && b.close(); return meta; }).catch(() => meta);
  }
  if (type === 'video' || type === 'audio') {
    return new Promise(res => {
      const m = document.createElement(type); const u = URL.createObjectURL(file);
      let fin = () => { fin = () => {}; URL.revokeObjectURL(u); m.removeAttribute('src'); res(meta); };
      m.preload = 'metadata';
      m.onloadedmetadata = () => { if (isFinite(m.duration)) meta.dur = m.duration; if (m.videoWidth) { meta.w = m.videoWidth; meta.h = m.videoHeight; } fin(); };
      m.onerror = () => fin(); setTimeout(() => fin(), 4000);
      m.src = u;
    });
  }
  return Promise.resolve(meta);
}

function xhr(method, url, body, onProgress, signal) {
  return new Promise((res, rej) => {
    const x = new XMLHttpRequest();
    x.open(method, url); x.withCredentials = true;
    if (!(body instanceof FormData)) x.setRequestHeader('Content-Type', 'application/octet-stream');
    x.upload.onprogress = e => onProgress && onProgress(e.loaded);
    x.onload = () => {
      let data = null; try { data = JSON.parse(x.responseText); } catch (e) {}
      if (x.status >= 200 && x.status < 300) res(data);
      else { const e = new Error(data && data.code === 'LIMIT' || x.status === 413 ? 'Over your storage limit' : (data && data.error) || `Upload failed (${x.status})`); e.status = x.status; e.code = data && data.code; rej(e); }
    };
    x.onerror = () => rej(Object.assign(new Error('Connection lost'), { code: 'NETWORK' }));
    x.onabort = () => rej(Object.assign(new Error('Cancelled'), { code: 'ABORT', name: 'AbortError' }));
    if (signal) { if (signal.aborted) return x.abort(); signal.addEventListener('abort', () => x.abort(), { once: true }); }
    x.send(body);
  });
}

function single(file, parent, meta, signal, progress) {
  const fd = new FormData();
  if (parent) fd.append('parent', parent);
  for (const k of ['type', 'dur', 'w', 'h']) if (meta[k] != null) fd.append(k, String(meta[k]));
  fd.append('file', file, file.name);
  progress(0, 'Uploading');
  return xhr('POST', '/api/files', fd, n => progress(file.size ? n / file.size : 1, n >= file.size ? 'Encrypting…' : 'Uploading'), signal);
}

async function chunked(file, parent, meta, signal, progress) {
  const init = await api('/api/uploads/init', { method: 'POST', json: { name: file.name, size: file.size, parent, ...meta }, signal });
  const size = init.chunkSize || 16 * 1024 * 1024;
  const offsets = []; for (let o = 0; o < file.size; o += size) offsets.push(o);
  const sent = new Map();
  const tick = () => { const n = [...sent.values()].reduce((a, b) => a + b, 0); progress(n / file.size, 'Uploading'); };
  let next = 0;
  const worker = async () => {
    while (next < offsets.length) {
      if (signal.aborted) throw Object.assign(new Error('Cancelled'), { code: 'ABORT' });
      const off = offsets[next++];
      for (let attempt = 0; ; attempt++) {
        try {
          await xhr('PUT', `/api/uploads/${init.uploadId}?offset=${off}`, file.slice(off, off + size), n => { sent.set(off, n); tick(); }, signal);
          sent.set(off, Math.min(size, file.size - off)); tick(); break;
        } catch (e) {
          if (e.code === 'ABORT' || attempt >= 2) throw e;
          await new Promise(r => setTimeout(r, 800 * (attempt + 1)));   // retry a dropped chunk twice
        }
      }
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(PARALLEL, init.maxParallel || PARALLEL, offsets.length || 1) }, worker));
    progress(1, 'Encrypting…');
    return await api(`/api/uploads/${init.uploadId}/complete`, { method: 'POST', timeout: 600000 });
  } catch (e) {
    api(`/api/uploads/${init.uploadId}`, { method: 'DELETE' }).catch(() => {});
    throw e;
  }
}

/* drag files from the desktop anywhere onto the window */
export function wireDropzone(getParent) {
  let depth = 0, overlay = null;
  // areas marked data-own-drop (a virtual machine's desktop) take drops themselves
  const isFiles = e => e.dataTransfer && [...e.dataTransfer.types].includes('Files') && !(e.target && e.target.closest && e.target.closest('[data-own-drop]'));
  window.addEventListener('dragenter', e => {
    if (!isFiles(e)) return; depth++;
    if (!overlay) { overlay = el(html`<div class="drop"><div class="box">${icon('upload', 40, 1.6)}<b>Drop to upload</b><span>into ${getParent() && store.byId(getParent()) ? store.byId(getParent()).name : 'All files'}</span></div></div>`.s); document.body.appendChild(overlay); }
  });
  window.addEventListener('dragover', e => { if (isFiles(e)) e.preventDefault(); });
  const hide = () => { depth = 0; if (overlay) { overlay.remove(); overlay = null; } };
  window.addEventListener('dragleave', e => { if (!isFiles(e)) return; if (--depth <= 0) hide(); });
  window.addEventListener('drop', e => {
    if (!isFiles(e)) return; e.preventDefault(); hide();
    const files = [...e.dataTransfer.files].filter(f => f.size > 0 || f.type);
    if (files.length) uploadFiles(files, getParent());
  });
}
