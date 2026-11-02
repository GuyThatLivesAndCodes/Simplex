/* store.js — the new UI's single source of truth: the signed-in account and the
   file list, plus every mutation the Database supports. Views subscribe with
   on('change', fn) and re-render from these getters; nothing else keeps copies. */
import { api } from './lib.js';

const listeners = new Map();
export function on(evt, fn) { if (!listeners.has(evt)) listeners.set(evt, new Set()); listeners.get(evt).add(fn); return () => listeners.get(evt).delete(fn); }
export function emit(evt, data) { if (evt === 'change') bump(); (listeners.get(evt) || []).forEach(fn => { try { fn(data); } catch (e) { console.error(e); } }); }

export const S = {
  account: null,
  used: 0,
  files: [],          // every row the server returned (trashed included)
  byId: new Map(),
  loaded: false,
  filesRev: null,
};

/* ---------- session ---------- */
export async function loadMe() {
  const me = await api('/api/me');
  S.account = me.account; S.used = me.used || 0;
  emit('account');
  return me;
}
export async function login(username, password) { return api('/api/login', { method: 'POST', json: { username, password } }); }
export async function login2fa(tk, code) { return api('/api/login/2fa', { method: 'POST', json: { tk, code } }); }
export async function logout() { try { await api('/api/logout', { method: 'POST' }); } catch (e) {} S.account = null; }

/* ---------- files ---------- */
export async function loadFiles() {
  const rows = await api('/api/files');
  setFiles(rows);
}
function setFiles(rows) {
  S.files = rows; S.byId = new Map(rows.map(r => [r.id, r])); S.loaded = true; bump();
  emit('change');
}
function upsert(row) {
  if (!row || !row.id) return;
  const i = S.files.findIndex(f => f.id === row.id);
  if (i >= 0) S.files[i] = row; else S.files.push(row);
  S.byId.set(row.id, row); bump();
}

/* Derived lists are cached per revision. Every mutation either goes through
   setFiles/upsert or ends with emit('change'), and both bump the revision, so a
   cached list is never stale by the time a view reads it. Callers get a fresh
   array copy where they might sort/modify it. */
let rev = 0, liveCache = null, liveRev = -1, kidsCache = null, kidsRev = -1;
function bump() { rev++; }
function liveList() { if (liveRev !== rev) { liveCache = S.files.filter(f => !f.trashed); liveRev = rev; } return liveCache; }
function kidsIndex() {
  if (kidsRev !== rev) {
    kidsCache = new Map();
    for (const f of liveList()) { const p = f.parent ?? null; let a = kidsCache.get(p); if (!a) kidsCache.set(p, a = []); a.push(f); }
    kidsRev = rev;
  }
  return kidsCache;
}

/* ---------- derived views ---------- */
export const live = () => liveList().slice();
export const byId = id => S.byId.get(id);
export const children = parent => (kidsIndex().get(parent ?? null) || []).slice();
export const childCount = parent => (kidsIndex().get(parent ?? null) || []).length;
export function pathOf(id) {
  const out = []; let f = byId(id), guard = 0;
  while (f && guard++ < 64) { out.unshift(f); f = f.parent ? byId(f.parent) : null; }
  return out;
}
export function descendants(id) {
  const out = [], q = [id];
  while (q.length) { const p = q.shift(); for (const f of S.files) if (f.parent === p) { out.push(f); if (f.type === 'folder') q.push(f.id); } }
  return out;
}
export const CATEGORIES = [
  { id: 'image', label: 'Photos', ic: 'image', path: 'photos' },
  { id: 'video', label: 'Films', ic: 'video', path: 'films' },
  { id: 'audio', label: 'Music', ic: 'audio', path: 'music' },
  { id: 'document', label: 'Documents', ic: 'document', path: 'documents' },
  { id: 'model3d', label: '3D models', ic: 'model3d', path: 'models' },
  { id: 'uasset', label: 'Game assets', ic: 'uasset', path: 'assets' },
];
export const ofType = t => liveList().filter(f => f.type === t);
export const starred = () => liveList().filter(f => f.starred);
export const recent = (n = 18) => liveList().filter(f => f.type !== 'folder').sort((a, b) => (b.date || 0) - (a.date || 0)).slice(0, n);
/* trash shows only the top of each trashed subtree (children ride along with their folder) */
export const trashed = () => S.files.filter(f => f.trashed && !(f.parent && byId(f.parent) && byId(f.parent).trashed));
export function search(q, limit = 60) {
  q = q.trim().toLowerCase(); if (!q) return [];
  const scored = [];
  for (const f of liveList()) {
    const n = (f.name || '').toLowerCase(); const i = n.indexOf(q);
    if (i < 0) continue;
    scored.push([f, (i === 0 ? 100 : 60 - Math.min(i, 50)) + (f.type === 'folder' ? 5 : 0)]);
  }
  return scored.sort((a, b) => b[1] - a[1]).slice(0, limit).map(x => x[0]);
}
export function sortItems(items, key = 'name', dir = 'asc', foldersFirst = true) {
  const m = dir === 'asc' ? 1 : -1;
  const val = f => key === 'size' ? (f.type === 'folder' ? -1 : f.size || 0) : key === 'date' ? f.date || 0 : key === 'type' ? (f.type || '') : (f.name || '').toLowerCase();
  return [...items].sort((a, b) => {
    if (foldersFirst && (a.type === 'folder') !== (b.type === 'folder')) return a.type === 'folder' ? -1 : 1;
    const x = val(a), y = val(b);
    return (x < y ? -1 : x > y ? 1 : 0) * m || (a.name || '').localeCompare(b.name || '');
  });
}

/* ---------- media urls ---------- */
export function thumbUrl(f) {
  if (!f || f.locked) return null;
  if (f.type === 'image') return f.posterUrl || f.url || null;
  if (f.type === 'video') return f.posterUrl || null;
  if (f.type === 'audio') return f.coverUrl ? f.coverUrl + (f.coverVer ? '?v=' + f.coverVer : '') : null;
  return null;
}

/* a thumbnail that's already cheap to fetch (an image or a stored cover) — never a
   video poster, which the server renders with ffmpeg on first request. Used where
   images load outside the thumbnail queue (home backdrops, viewer ambient glow). */
export function cheapThumb(f) {
  const t = thumbUrl(f);
  return t && !/\/poster(\?|$)/.test(t) ? t : null;
}

/* ---------- mutations (optimistic where it's safe) ---------- */
export async function createFolder(name, parent) { const row = await api('/api/folders', { method: 'POST', json: { name, parent: parent ?? null } }); upsert(row); emit('change'); return row; }
export async function rename(id, name) { const row = await api('/api/files/' + id, { method: 'PATCH', json: { name } }); upsert(row); emit('change'); return row; }
export async function setStar(id, on) {
  const f = byId(id); if (f) { f.starred = on; emit('change'); }
  try { upsert(await api('/api/files/' + id, { method: 'PATCH', json: { starred: on } })); }
  catch (e) { if (f) f.starred = !on; emit('change'); throw e; }
}
export async function trash(ids) {
  for (const id of ids) { const r = await api(`/api/files/${id}/trash`, { method: 'POST' }); (r.ids || [id]).forEach(i => { const f = byId(i); if (f) f.trashed = true; }); }
  emit('change');
}
export async function restore(ids) {
  for (const id of ids) { const r = await api(`/api/files/${id}/restore`, { method: 'POST' }); (r.ids || [id]).forEach(i => { const f = byId(i); if (f) f.trashed = false; }); }
  emit('change');
}
export async function destroy(ids) {
  for (const id of ids) {
    const r = await api('/api/files/' + id, { method: 'DELETE' });
    const gone = new Set(r.ids || [id]);
    S.files = S.files.filter(f => !gone.has(f.id)); gone.forEach(i => S.byId.delete(i));
  }
  await refreshUsage(); emit('change');
}
export async function emptyTrash() { await api('/api/trash/empty', { method: 'POST' }); await loadFiles(); await refreshUsage(); }
export async function move(ids, parent) {
  const r = await api('/api/files/move', { method: 'POST', json: { ids, parent: parent ?? null } });
  (r.moved || []).forEach(i => { const f = byId(i); if (f) f.parent = parent ?? null; });
  emit('change');
  return r;
}
export async function saveContent(id, content) {
  const row = await api('/api/files/' + id, { method: 'PATCH', json: { content, size: new Blob([content]).size, date: Date.now() } });
  upsert(row); emit('change'); return row;
}
export async function fetchText(f) {
  // content-backed docs live in the encrypted `content` column; blob-backed ones stream raw
  if (!f.url) { const r = await api(`/api/files/${f.id}/content`); return r.content || ''; }
  const res = await fetch(f.url, { credentials: 'same-origin' });
  if (!res.ok) throw new Error('Could not load file');
  return res.text();
}
export function added(row) { upsert(row); emit('change'); }
export async function refreshUsage() { try { const me = await api('/api/me'); S.used = me.used || 0; S.account = me.account; emit('account'); } catch (e) {} }

/* ---------- live updates ---------- */
let pollTimer = null, polling = false, visWired = false;
export function startPolling() {
  stopPolling();
  const tick = async () => {
    if (polling || document.hidden) return;
    polling = true;
    try {
      const p = await api('/api/poll');
      if (p.account) S.account = p.account;
      if (typeof p.used === 'number') S.used = p.used;
      if (S.filesRev != null && p.filesRev !== S.filesRev) await loadFiles();
      S.filesRev = p.filesRev;
      emit('account');
    } catch (e) {
      if (e.status === 401) { stopPolling(); emit('signedout'); }
    } finally { polling = false; }
  };
  tick();
  pollTimer = setInterval(tick, 8000);
  if (!visWired) { visWired = true; document.addEventListener('visibilitychange', () => { if (pollTimer) tick(); }); }
}
export function stopPolling() { clearInterval(pollTimer); pollTimer = null; }
