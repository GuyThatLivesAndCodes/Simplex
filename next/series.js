/* series.js — the user's own shows, made from their videos (Tools → Series Maker),
   watched like a streaming service: #/series lists them, #/series/<id> is a show
   page with seasons, episodes, what's been watched, where each was left off, and a
   Continue button that picks the right episode. Episodes play in order in the
   viewer and roll on to the next one at the end. */
import { html, raw, icon, esc, fmtDur, api, plural } from './lib.js';
import * as store from './store.js';
import { toast, menu, dialog } from './ui.js';
import { openViewer } from './viewer.js';

/* ---------- data ---------- */
export const SER = { list: [], watched: {}, progress: {}, loaded: false };
let loading = null;
export function loadSeries(force) {
  if (loading) return loading;
  if (SER.loaded && !force) return Promise.resolve(SER);
  loading = api('/api/series', { timeout: 15000 }).then(r => {
    SER.list = r.series || []; SER.watched = r.watched || {}; SER.progress = r.progress || {}; SER.loaded = true;
    return SER;
  }).finally(() => { loading = null; });
  return loading;
}
export const seriesById = id => SER.list.find(s => s.id === id) || null;
export async function createSeries(data) { const s = await api('/api/series', { method: 'POST', json: data }); SER.list.unshift(s); return s; }
export async function updateSeries(id, patch) {
  const s = await api('/api/series/' + encodeURIComponent(id), { method: 'PATCH', json: patch });
  const i = SER.list.findIndex(x => x.id === id); if (i >= 0) SER.list[i] = s; else SER.list.unshift(s);
  return s;
}
export async function deleteSeries(id) { await api('/api/series/' + encodeURIComponent(id), { method: 'DELETE' }); SER.list = SER.list.filter(s => s.id !== id); }

/* episodes whose video still exists (not trashed), in watching order */
export const liveEpisodes = s => (s ? s.episodes : []).filter(e => { const f = store.byId(e.fileId); return f && !f.trashed; });
export const seasonsOf = eps => [...new Set(eps.map(e => e.season))].sort((a, b) => (a || 1e9) - (b || 1e9));
export const seasonName = n => (n === 0 ? 'Specials' : 'Season ' + n);
export const epLabel = e => (e.season === 0 ? 'Special ' : 'S' + e.season + ' · E') + e.episode;
export const epTitle = e => e.title || cleanTitle((store.byId(e.fileId) || {}).name || '');

/* "My.Show.S01E03.Walkies.1080p.mp4" -> "Walkies" (or the whole stem if nothing is left) */
export function cleanTitle(name) {
  const stem = String(name).replace(/\.[^.]+$/, '');
  const t = stem.replace(/^.*?\bs\d{1,3}[\s._-]*e\d{1,4}\b/i, '').replace(/\b(480|720|1080|2160)p\b.*$/i, '')
    .replace(/[._]+/g, ' ').replace(/^[\s\-–:]+|[\s\-–:]+$/g, '').trim();
  return t || stem.replace(/[._]+/g, ' ').trim();
}
/* season/episode numbers from a file name, when it carries them */
export function parseSE(name) {
  const n = String(name);
  let m = /\bs(\d{1,3})[\s._-]*e(\d{1,4})\b/i.exec(n) || /\b(\d{1,2})x(\d{1,3})\b/.exec(n) || /season[\s._-]*(\d{1,3}).*?episode[\s._-]*(\d{1,4})/i.exec(n);
  if (m) return { season: +m[1], episode: +m[2] };
  m = /\b(?:ep|episode|e)[\s._-]*(\d{1,4})\b/i.exec(n);
  return m ? { episode: +m[1] } : {};
}
export const natural = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

/* state of one episode: 'watched' | 'progress' | 'new', and how far along (0–1) */
export function epState(e) {
  if (SER.watched[e.fileId]) return { st: 'watched', p: 1 };
  const pr = SER.progress[e.fileId], f = store.byId(e.fileId);
  const d = (pr && pr.dur) || (f && f.dur) || 0;
  if (pr && pr.pos > 0) return { st: 'progress', p: d ? Math.min(0.98, pr.pos / d) : 0.05, pos: pr.pos, updated: pr.updated };
  return { st: 'new', p: 0 };
}
/* the episode to put on the big button: the one left half-way most recently, else
   the first unwatched one after the furthest watched, else the start */
export function nextUp(s) {
  const eps = liveEpisodes(s); if (!eps.length) return null;
  const states = eps.map(epState);
  const partial = eps.map((e, i) => ({ e, s: states[i] })).filter(x => x.s.st === 'progress').sort((a, b) => (b.s.updated || 0) - (a.s.updated || 0))[0];
  if (partial) return { e: partial.e, how: 'continue' };
  let last = -1; states.forEach((x, i) => { if (x.st === 'watched') last = i; });
  for (let i = last + 1; i < eps.length; i++) if (states[i].st !== 'watched') return { e: eps[i], how: last >= 0 ? 'next' : 'start' };
  const first = states.findIndex(x => x.st !== 'watched');
  return first >= 0 ? { e: eps[first], how: 'next' } : { e: eps[0], how: 'again' };
}
const coverOf = s => { const e = liveEpisodes(s)[0]; const f = e && store.byId(e.fileId); return f ? store.thumbUrl(f) || f.posterUrl || null : null; };

/* play an episode with the rest of the series queued after it */
export function playEpisode(s, e) {
  const eps = liveEpisodes(s), files = eps.map(x => store.byId(x.fileId));
  const f = store.byId(e.fileId); if (!f) return toast('That video is gone', { bad: true });
  openViewer(f, files, { autoNext: true, autoResume: true, labels: Object.fromEntries(eps.map(x => [x.fileId, `${s.name} · ${epLabel(x)}`])) });
}

/* ---------- #/series and #/series/<id> ---------- */
let R = null;   // { stage, id }
export async function renderSeries(stage, r) {
  R = { stage, id: r.arg || null };
  const paint = () => { if (R && R.stage === stage) (R.id ? paintShow(seriesById(R.id)) : paintList()); };
  // what's cached shows at once; what's been watched (maybe on another device) follows
  const sig = () => JSON.stringify([SER.list, SER.watched, SER.progress]);
  const before = SER.loaded ? sig() : null;
  if (SER.loaded) paint(); else stage.innerHTML = '<div class="page"><div class="empty"><span class="spin"></span></div></div>';
  try { await loadSeries(true); } catch (e) { if (!SER.loaded) stage.innerHTML = html`<div class="page"><div class="empty"><b>Couldn’t load your series</b><span>${e.message}</span></div></div>`.s; return; }
  if (sig() !== before) paint();
}
export function leaveSeries() { R = null; }
// coming back from the viewer: refresh what's been watched
window.addEventListener('nx:viewerclosed', () => { if (R) loadSeries(true).then(() => { if (R) (R.id ? paintShow(seriesById(R.id)) : paintList()); }).catch(() => {}); });

function seriesCard(s, i) {
  const eps = liveEpisodes(s), cover = coverOf(s), seen = eps.filter(e => SER.watched[e.fileId]).length, nu = nextUp(s);
  return html`<a class="srcard" href="#/series/${s.id}" style="--i:${i}">
    <div class="src-art">${cover ? raw(`<img src="${esc(cover)}" alt="" loading="lazy">`) : html`<span class="tint t-video">${icon('video', 30, 1.5)}</span>`}
      ${eps.length ? html`<i class="src-bar"><b style="width:${(seen / eps.length * 100).toFixed(1)}%"></b></i>` : ''}</div>
    <div class="src-txt"><b>${s.name}</b><small>${eps.length ? `${plural(seasonsOf(eps).filter(n => n > 0).length || 1, 'season')} · ${plural(eps.length, 'episode')}` : 'No episodes yet'}${seen ? ` · ${seen} watched` : ''}</small>
      ${nu && nu.how !== 'start' ? html`<span class="src-next">${icon('play', 11)} ${nu.how === 'continue' ? 'Continue' : nu.how === 'again' ? 'Watch again' : 'Up next'}: ${epLabel(nu.e)}</span>` : ''}</div></a>`;
}
function paintList() {
  const { stage } = R;
  const list = SER.list;
  stage.innerHTML = html`<div class="page page-enter">
    <header class="fhead"><div><h1>Series</h1><div class="meta">${list.length ? plural(list.length, 'series', 'series') : 'Your own shows, made from your videos'}</div></div>
      <div class="acts"><a class="b" href="#/tools/series">${icon('pencil', 16)} Series Maker</a><a class="b pri" href="#/tools/series/new">${icon('plus', 16)} New series</a></div></header>
    ${list.length ? html`<div class="srgrid">${list.map(seriesCard)}</div>` : html`<div class="empty"><span class="ei">${icon('video', 30, 1.5)}</span><b>No series yet</b>
      <span>Turn your videos into a show: give it a name, put episodes into seasons, and watch them in order.</span>
      <a class="b pri" href="#/tools/series/new" style="margin-top:8px">${icon('plus', 16)} Make a series</a></div>`}
  </div>`.s;
}

let season = null;   // the season tab showing on the show page
function paintShow(s) {
  const { stage } = R;
  if (!s) { stage.innerHTML = html`<div class="page"><div class="empty"><b>That series doesn’t exist</b><a class="b" href="#/series">All series</a></div></div>`.s; return; }
  const eps = liveEpisodes(s), seasons = seasonsOf(eps), cover = coverOf(s), nu = nextUp(s);
  if (!seasons.includes(season)) season = nu ? nu.e.season : seasons[0];
  const seen = eps.filter(e => SER.watched[e.fileId]).length;
  const cta = !nu ? '' : nu.how === 'continue' ? `Continue ${epLabel(nu.e)}` : nu.how === 'again' ? 'Watch again' : nu.how === 'start' ? 'Play' : `Play ${epLabel(nu.e)}`;
  stage.innerHTML = html`<div class="page page-enter srshow">
    <header class="sr-hero">${cover ? raw(`<div class="sr-bg" style="background-image:url('${esc(cover)}')"></div>`) : ''}
      <div class="sr-in"><a class="sr-back" href="#/series">${icon('back', 14)} Series</a>
        <h1>${s.name}</h1>
        <div class="sr-meta">${eps.length ? `${plural(seasons.filter(n => n > 0).length || 1, 'season')} · ${plural(eps.length, 'episode')} · ${seen ? `${seen} of ${eps.length} watched` : 'not started'}` : 'No episodes yet'}</div>
        ${s.description ? html`<p class="sr-desc">${s.description}</p>` : ''}
        <div class="sr-cta">${nu ? html`<button class="b pri lg" data-play>${icon('play', 16)} ${cta}</button>` : ''}
          <a class="b" href="#/tools/series/${s.id}">${icon('pencil', 15)} Edit</a>
          ${eps.length ? html`<button class="ib" data-more title="More">${icon('more', 18)}</button>` : ''}</div>
        ${nu && nu.how === 'continue' ? html`<div class="sr-resume"><i><b style="width:${(epState(nu.e).p * 100).toFixed(1)}%"></b></i><span>${fmtDur(epState(nu.e).pos || 0)} in · ${epTitle(nu.e)}</span></div>` : ''}
      </div></header>
    ${eps.length ? html`
      ${seasons.length > 1 ? html`<div class="sr-tabs" role="tablist">${seasons.map(n => html`<button role="tab" data-season="${n}" class="${n === season ? 'on' : ''}">${seasonName(n)}</button>`)}</div>` : html`<div class="sect"><h2>${seasonName(seasons[0])}</h2></div>`}
      <div class="sr-eps">${eps.filter(e => e.season === season).map(e => epRow(e))}</div>`
      : html`<div class="empty"><b>No episodes yet</b><span>Add videos to this series in the Series Maker.</span><a class="b pri" href="#/tools/series/${s.id}">${icon('plus', 16)} Add episodes</a></div>`}
  </div>`.s;
  const root = stage.firstElementChild;
  root.onclick = e => {
    const play = e.target.closest('[data-play]'); if (play) { if (nu) playEpisode(s, nu.e); return; }
    const tab = e.target.closest('[data-season]'); if (tab) { season = +tab.dataset.season; paintShow(s); return; }
    const more = e.target.closest('[data-more]');
    if (more) return menu([
      { label: 'Mark all watched', ic: 'check', run: () => markMany(s, eps, true) },
      { label: 'Mark all unwatched', ic: 'restore', run: () => markMany(s, eps, false) },
    ], more);
    const row = e.target.closest('[data-ep]'); if (!row) return;
    const ep = eps.find(x => x.fileId === row.dataset.ep);
    if (e.target.closest('[data-epmenu]')) return epMenu(s, ep, e.target.closest('[data-epmenu]'));
    playEpisode(s, ep);
  };
  root.oncontextmenu = e => { const row = e.target.closest('[data-ep]'); if (!row) return; e.preventDefault(); epMenu(s, eps.find(x => x.fileId === row.dataset.ep), { x: e.clientX, y: e.clientY }); };
}
function epRow(e) {
  const f = store.byId(e.fileId), st = epState(e), t = f && (store.thumbUrl(f) || f.posterUrl);
  const dur = (f && f.dur) || (SER.progress[e.fileId] || {}).dur || 0;
  return html`<div class="sr-ep${st.st === 'watched' ? ' seen' : ''}" data-ep="${e.fileId}" tabindex="0">
    <div class="sr-th">${t ? raw(`<img src="${esc(t)}" alt="" loading="lazy">`) : html`<span class="tint t-video">${icon('video', 22, 1.6)}</span>`}
      <span class="sr-playic">${icon('play', 18)}</span>
      ${st.p ? html`<i class="sr-pbar"><b style="width:${(st.p * 100).toFixed(1)}%"></b></i>` : ''}
      ${st.st === 'watched' ? html`<span class="sr-seen" title="Watched">${icon('check', 12, 2.6)}</span>` : ''}</div>
    <div class="sr-et"><span class="sr-n">${e.season === 0 ? 'Special ' + e.episode : 'Episode ' + e.episode}</span><b>${epTitle(e)}</b>
      <small>${[dur ? fmtDur(dur) : '', st.st === 'progress' ? (dur ? `${fmtDur(Math.max(0, dur - (st.pos || 0)))} left` : 'In progress') : st.st === 'watched' ? 'Watched' : ''].filter(Boolean).join(' · ')}</small></div>
    <button class="ib" data-epmenu title="More">${icon('more', 17)}</button></div>`;
}
function epMenu(s, e, at) {
  const st = epState(e);
  menu([
    { label: st.st === 'progress' ? 'Resume' : 'Play', ic: 'play', run: () => playEpisode(s, e) },
    st.st === 'progress' && { label: 'Play from the start', ic: 'restore', run: async () => { await api(`/api/files/${e.fileId}/progress`, { method: 'DELETE' }).catch(() => {}); delete SER.progress[e.fileId]; playEpisode(s, e); } },
    st.st === 'watched' ? { label: 'Mark as not watched', ic: 'restore', run: () => markMany(s, [e], false) } : { label: 'Mark as watched', ic: 'check', run: () => markMany(s, [e], true) },
    { label: 'Mark everything before as watched', ic: 'check', run: () => { const eps = liveEpisodes(s); markMany(s, eps.slice(0, eps.indexOf(e)), true); } },
  ].filter(Boolean), at);
}
async function markMany(s, eps, on) {
  try {
    await Promise.all(eps.map(e => api(`/api/files/${e.fileId}/watched`, { method: 'POST', json: { watched: on } })));
    eps.forEach(e => { if (on) { SER.watched[e.fileId] = Date.now(); delete SER.progress[e.fileId]; } else delete SER.watched[e.fileId]; });
    if (R && R.id === s.id) paintShow(s);
  } catch (err) { toast(err.message, { bad: true }); }
}

/* ---------- "Add to series…" from a video's menu ---------- */
export async function addToSeriesDialog(ids) {
  const vids = ids.map(store.byId).filter(f => f && f.type === 'video').sort((a, b) => natural(a.name, b.name));
  if (!vids.length) return toast('Pick videos to add to a series', { bad: true });
  try { await loadSeries(); } catch (e) { return toast(e.message, { bad: true }); }
  const opts = SER.list.map(s => html`<option value="${s.id}">${s.name}</option>`.s).join('');
  dialog({
    ic: 'video', tint: 't-video', title: 'Add to a series', text: vids.length === 1 ? vids[0].name : plural(vids.length, 'video') + ' as episodes, in name order',
    body: html`<label class="fld"><span>Series</span><select class="in" data-s>${raw(opts)}<option value="__new">New series…</option></select></label>
      <label class="fld" data-newrow hidden><span>Name</span><input class="in" data-name placeholder="My Dog Life" maxlength="120"></label>
      <div class="fld-row"><label class="fld"><span>Season</span><input class="in" type="number" min="0" data-season value="1"></label>
        <label class="fld"><span>${vids.length > 1 ? 'First episode' : 'Episode'}</span><input class="in" type="number" min="1" data-ep value="1"></label></div>
      <p class="dim" style="font-size:12.5px;margin:4px 0 0">${icon('info', 12)} Season 0 is for specials. Numbers in file names (S01E03) are used when there.</p>`,
    actions: [{ label: 'Cancel' }, { label: 'Add', kind: 'pri', run: async (_c, r) => {
      const sid = r.querySelector('[data-s]').value, season = Math.max(0, parseInt(r.querySelector('[data-season]').value, 10) || 0);
      let ep = Math.max(1, parseInt(r.querySelector('[data-ep]').value, 10) || 1);
      // a name with S01E03 in it numbers itself; everything else takes the next number
      const add = vids.map(f => { const se = parseSE(f.name); if (se.season != null && se.episode) return { fileId: f.id, season: se.season, episode: se.episode, title: cleanTitle(f.name) }; return { fileId: f.id, season, episode: ep++, title: cleanTitle(f.name) }; });
      try {
        let s;
        if (sid === '__new') {
          const name = r.querySelector('[data-name]').value.trim(); if (!name) { r.querySelector('[data-name]').focus(); return false; }
          s = await createSeries({ name, episodes: add });
        } else {
          const cur = seriesById(sid), keep = cur.episodes.filter(e => !add.some(a => a.fileId === e.fileId));
          s = await updateSeries(sid, { episodes: [...keep, ...add] });
        }
        toast(`Added to ${s.name}`, { ic: 'video', action: 'Open', onAction: () => { location.hash = '#/series/' + s.id; } });
      } catch (e) { toast(e.message, { bad: true }); return false; }
    } }],
    onMount: r => {
      const sel = r.querySelector('[data-s]'), row = r.querySelector('[data-newrow]');
      const sync = () => {
        row.hidden = sel.value !== '__new';
        const s = seriesById(sel.value);
        if (s && s.episodes.length) { const last = s.episodes[s.episodes.length - 1]; r.querySelector('[data-season]').value = last.season; r.querySelector('[data-ep]').value = last.episode + 1; }
        else { r.querySelector('[data-season]').value = 1; r.querySelector('[data-ep]').value = 1; }
        if (!row.hidden) r.querySelector('[data-name]').focus();
      };
      sel.onchange = sync;
      if (!SER.list.length) sel.value = '__new';
      sync();
    },
  });
}
