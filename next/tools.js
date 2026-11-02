/* tools.js — the Tools app. #/tools is the hub; each tool is a page under it:
     #/tools/convert          Converter: pick or drop a file, choose a format
     #/tools/series[/<id>]    Series Maker: build shows out of your videos
   Watching a series happens in series.js (#/series). */
import { html, raw, icon, esc, fmtSize, fmtDur, plural, debounce } from './lib.js';
import * as store from './store.js';
import { toast, confirm } from './ui.js';
import { pickFiles } from './pick.js';
import { uploadAndWait } from './upload.js';
import { canConvert, convertDialog } from './jobs.js';
import { conversionsFor } from './formats.js';
import { allTasks, onTasks, toggle as toggleActivity } from './tasks.js';
import { SER, loadSeries, seriesById, createSeries, updateSeries, deleteSeries, liveEpisodes, seasonsOf, seasonName, cleanTitle, parseSE, natural } from './series.js';

const TOOLS = [
  { id: 'convert', name: 'Converter', ic: 'swap', tint: 't-image', desc: 'Change a video, song or picture into another format' },
  { id: 'series', name: 'Series Maker', ic: 'video', tint: 't-video', desc: 'Turn your videos into a show with seasons and episodes' },
];

let T = null;   // { stage, tool, arg, off }
export function renderTools(stage, r) {
  leaveTools();
  const [tool, arg] = (r.arg ? [r.arg, r.sub] : [null, null]);
  T = { stage, tool, arg: arg || null };
  if (tool === 'convert') return paintConverter();
  if (tool === 'series') return paintMaker();
  paintHub();
}
export function leaveTools() { if (T && T.off) T.off(); T = null; }

/* ---------- hub ---------- */
async function paintHub() {
  const { stage } = T;
  stage.innerHTML = html`<div class="page page-enter">
    <header class="fhead"><div><h1>Tools</h1><div class="meta">Small things that do one job well</div></div></header>
    <div class="tgrid">${TOOLS.map((t, i) => html`<a class="ttile" href="#/tools/${t.id}" style="--i:${i}"><span class="tti tint ${t.tint}">${icon(t.ic, 24)}</span><span><b>${t.name}</b><small>${t.desc}</small></span>${icon('chevron', 16)}</a>`)}</div>
    <div class="sect"><h2>Your series</h2><a href="#/series">All series ${icon('chevron', 13)}</a></div>
    <div data-shelf><div class="dim" style="font-size:13px">Loading…</div></div>
  </div>`.s;
  try { await loadSeries(); } catch (e) {}
  const shelf = T && T.stage === stage && stage.querySelector('[data-shelf]'); if (!shelf) return;
  shelf.innerHTML = SER.list.length
    ? html`<div class="srgrid small">${SER.list.slice(0, 6).map(s => { const eps = liveEpisodes(s); const f = eps[0] && store.byId(eps[0].fileId); const c = f && (store.thumbUrl(f) || f.posterUrl);
      return html`<a class="srcard" href="#/series/${s.id}"><div class="src-art">${c ? raw(`<img src="${esc(c)}" alt="" loading="lazy">`) : html`<span class="tint t-video">${icon('video', 26, 1.5)}</span>`}</div><div class="src-txt"><b>${s.name}</b><small>${plural(eps.length, 'episode')}</small></div></a>`; })}</div>`.s
    : html`<div class="dim" style="font-size:13px">None yet — make one with the Series Maker.</div>`.s;
}

/* ---------- Converter ---------- */
function paintConverter() {
  const { stage } = T;
  stage.innerHTML = html`<div class="page page-enter">
    <header class="fhead"><div><a class="sr-back" href="#/tools">${icon('back', 14)} Tools</a><h1>Converter</h1><div class="meta">Video, audio and pictures — converted on the server, saved beside the original</div></div></header>
    <div class="cvt-drop" data-own-drop tabindex="0">
      <span class="cvt-ic tint t-image">${icon('swap', 30, 1.6)}</span>
      <b>Drop a file here to convert it</b>
      <span class="dim">MP4, MKV, MOV, WebM, MP3, WAV, FLAC, PNG, JPG, WebP, TIFF, EXR and more</span>
      <div class="cvt-acts"><button class="b pri" data-pick>${icon('database', 16)} Choose from Database</button><button class="b" data-up>${icon('upload', 16)} From this computer</button></div>
      <input type="file" hidden data-file>
    </div>
    <div class="sect"><h2>Conversions</h2><button class="link" data-activity>Activity ${icon('chevron', 13)}</button></div>
    <div class="cvt-list" data-list></div>
  </div>`.s;
  const root = stage.firstElementChild, drop = root.querySelector('.cvt-drop'), fileIn = root.querySelector('[data-file]');
  root.querySelector('[data-pick]').onclick = pickVault;
  root.querySelector('[data-up]').onclick = () => fileIn.click();
  root.querySelector('[data-activity]').onclick = () => toggleActivity(true);
  fileIn.onchange = () => { if (fileIn.files[0]) fromComputer(fileIn.files[0]); fileIn.value = ''; };
  let depth = 0;
  drop.addEventListener('dragenter', e => { e.preventDefault(); depth++; drop.classList.add('over'); });
  drop.addEventListener('dragover', e => e.preventDefault());
  drop.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; drop.classList.remove('over'); } });
  drop.addEventListener('drop', e => {
    e.preventDefault(); depth = 0; drop.classList.remove('over');
    const ids = e.dataTransfer.getData('application/x-simplex-ids');   // dragged from a file list
    if (ids) { try { const [id] = JSON.parse(ids); return openConvert(store.byId(id)); } catch (err) {} }
    const files = [...(e.dataTransfer.files || [])];
    if (files.length > 1) toast('One at a time — converting the first file', { ic: 'info' });
    if (files[0]) fromComputer(files[0]);
  });
  const paintList = () => {
    const box = T && T.stage === stage && root.querySelector('[data-list]'); if (!box) return;
    const list = allTasks().filter(t => t.kind === 'convert').slice(-12).reverse();
    box.innerHTML = list.length ? list.map(t => html`<div class="cvt-row ${t.state}"><span class="tint ${t.tint}">${icon('swap', 16)}</span>
      <div><b>${t.title}</b><small>${t.sub} · ${t.state === 'running' ? (t.detail || 'Converting') + (t.progress != null ? ' · ' + Math.round(t.progress * 100) + '%' : '') : t.state === 'done' ? 'Done' : t.state === 'failed' ? (t.detail || 'Failed') : t.state === 'queued' ? 'Waiting' : t.detail}</small>
      ${t.state === 'running' && t.progress != null ? html`<i class="cvt-bar"><b style="width:${(t.progress * 100).toFixed(1)}%"></b></i>` : ''}</div>
      ${t.state === 'done' && t.result ? html`<button class="b sm" data-open="${t.result.id}">Open</button>` : ''}</div>`.s).join('')
      : html`<div class="dim" style="font-size:13px">Nothing converted yet in this session.</div>`.s;
  };
  root.querySelector('[data-list]').onclick = e => { const b = e.target.closest('[data-open]'); if (b) import('./viewer.js').then(v => { const f = store.byId(b.dataset.open); if (f) v.openViewer(f, [f]); }); };
  paintList();
  const unsub = onTasks(debounce(paintList, 150));
  T.off = unsub;
}
function openConvert(f) {
  if (!f) return;
  if (!canConvert(f)) return toast(f.locked ? 'Unlock this file before converting it' : `Simplex can’t convert .${(f.name.split('.').pop() || '').toLowerCase()} files`, { bad: true });
  convertDialog(f.id);
}
async function pickVault() {
  const ids = await pickFiles({ title: 'Choose a file to convert', filter: canConvert, okLabel: 'Choose', empty: 'No convertible files (video, audio, pictures) in your Database' });
  if (ids) openConvert(store.byId(ids[0]));
}
/* a file from the computer goes into the Database first (conversions run on the
   stored copy), then straight into the format picker */
async function fromComputer(file) {
  if (!conversionsFor({ name: file.name }).length) return toast(`Simplex can’t convert .${(file.name.split('.').pop() || '').toLowerCase()} files`, { bad: true });
  toast(`Uploading ${file.name} — the format picker opens when it’s in`, { ic: 'upload' });
  try { const row = await uploadAndWait(file, null); if (row) openConvert(store.byId(row.id) || row); }
  catch (e) { toast(e.message || 'Upload failed', { bad: true }); }
}

/* ---------- Series Maker ---------- */
let E = null;   // the series being edited: { id|null, name, description, episodes, extra: Set(seasons), status }
async function paintMaker() {
  const { stage } = T, want = T.arg;
  stage.innerHTML = '<div class="page"><div class="empty"><span class="spin"></span></div></div>';
  try { await loadSeries(); } catch (e) { stage.innerHTML = html`<div class="page"><div class="empty"><b>Couldn’t load your series</b><span>${e.message}</span></div></div>`.s; return; }
  if (!T || T.stage !== stage) return;
  if (want === 'new' || (!want && !SER.list.length)) E = { id: null, name: '', description: '', episodes: [], extra: new Set([1]), status: '' };
  else {
    const s = seriesById(want) || (!want ? SER.list[0] : null);
    if (!s) { stage.innerHTML = html`<div class="page"><div class="empty"><b>That series doesn’t exist</b><a class="b" href="#/tools/series">Series Maker</a></div></div>`.s; return; }
    E = { id: s.id, name: s.name, description: s.description, episodes: s.episodes.map(e => ({ ...e })), extra: new Set(), status: 'Saved' };
  }
  stage.innerHTML = html`<div class="page page-enter">
    <header class="fhead"><div><a class="sr-back" href="#/tools">${icon('back', 14)} Tools</a><h1>Series Maker</h1><div class="meta">Pick videos, put them in seasons, number the episodes — then watch them in order</div></div>
      <div class="acts"><a class="b" href="#/series">${icon('play', 15)} Watch your series</a></div></header>
    <div class="smk"><aside class="sm-list" data-list></aside><section class="sm-ed" data-ed></section></div>
  </div>`.s;
  const root = stage.firstElementChild;
  root.querySelector('[data-list]').onclick = e => { const b = e.target.closest('[data-sid]'); if (b) location.hash = '#/tools/series/' + b.dataset.sid; };
  paintSideList(); paintEditor();
}
function paintSideList() {
  const box = T && T.stage.querySelector('[data-list]'); if (!box) return;
  box.innerHTML = html`<button class="sm-item new${E.id ? '' : ' on'}" data-sid="new">${icon('plus', 16)}<span><b>New series</b></span></button>
    ${SER.list.map(s => html`<button class="sm-item${E.id === s.id ? ' on' : ''}" data-sid="${s.id}"><span class="tint t-video">${icon('video', 15)}</span><span><b>${s.name}</b><small>${plural(liveEpisodes(s).length, 'episode')}</small></span></button>`)}`.s;
}

const sortEps = () => E.episodes.sort((a, b) => (a.season || 1e9) - (b.season || 1e9) || a.episode - b.episode || natural(String(a.title), String(b.title)));
function paintEditor() {
  const box = T && T.stage.querySelector('[data-ed]'); if (!box) return;
  sortEps();
  const seasons = [...new Set([...seasonsOf(E.episodes), ...E.extra])].sort((a, b) => (a || 1e9) - (b || 1e9));
  const dupKey = e => e.season + ':' + e.episode, counts = {};
  E.episodes.forEach(e => { counts[dupKey(e)] = (counts[dupKey(e)] || 0) + 1; });
  const hasDup = Object.values(counts).some(n => n > 1);
  box.innerHTML = html`
    <div class="sm-head">
      <input class="in sm-name" data-f="name" placeholder="Series name — e.g. My Dog Life" maxlength="120" value="${E.name}">
      <textarea class="in sm-desc" data-f="description" placeholder="What it’s about (optional)" maxlength="2000" rows="2">${E.description}</textarea>
    </div>
    <div class="sm-bar">
      ${E.id ? html`<span class="sm-st" data-st>${E.status}</span>` : html`<button class="b pri" data-create>${icon('check', 15)} Create series</button>`}
      <span class="sp"></span>
      <button class="b sm" data-newseason>${icon('plus', 14)} New season</button>
      ${E.episodes.length ? html`<button class="b sm" data-renumber title="Number each season 1, 2, 3… in the order shown">${icon('sort', 14)} Number in order</button>` : ''}
      ${E.id ? html`<a class="b sm" href="#/series/${E.id}">${icon('play', 14)} Watch</a><button class="ib" data-del title="Delete this series">${icon('trash', 17)}</button>` : ''}
    </div>
    ${hasDup ? html`<p class="sm-warn">${icon('info', 13)} Two episodes share the same season and episode number — they’ll play in name order.</p>` : ''}
    ${seasons.map(n => { const eps = E.episodes.filter(e => e.season === n); return html`<div class="sm-season">
      <div class="sm-sh"><b>${seasonName(n)}</b><small>${eps.length ? plural(eps.length, 'episode') : 'empty'}</small><span class="sp"></span><button class="b sm" data-add="${n}">${icon('plus', 14)} Add videos</button></div>
      ${eps.length ? eps.map(e => { const i = E.episodes.indexOf(e), f = store.byId(e.fileId), t = f && (store.thumbUrl(f) || f.posterUrl);
        return html`<div class="sm-ep${counts[dupKey(e)] > 1 ? ' dup' : ''}${!f || f.trashed ? ' gone' : ''}" data-i="${i}">
          <div class="sm-th">${t ? raw(`<img src="${esc(t)}" alt="" loading="lazy">`) : html`<span class="tint t-video">${icon('video', 18)}</span>`}</div>
          <div class="sm-et"><input class="in sm" data-k="title" placeholder="${f ? cleanTitle(f.name) : 'Missing video'}" value="${e.title || ''}" maxlength="200"><small>${f ? f.name + (f.dur ? ' · ' + fmtDur(f.dur) : '') + (f.trashed ? ' · in Trash' : '') : 'This video was deleted'}</small></div>
          <label class="sm-num"><span>S</span><input class="in sm" type="number" min="0" max="999" data-k="season" value="${e.season}"></label>
          <label class="sm-num"><span>E</span><input class="in sm" type="number" min="1" max="9999" data-k="episode" value="${e.episode}"></label>
          <div class="sm-mv"><button class="ib sm" data-mv="-1" title="Earlier">${icon('arrowup', 15)}</button><button class="ib sm" data-mv="1" title="Later">${icon('arrowdown', 15)}</button></div>
          <button class="ib sm" data-rm title="Remove from the series">${icon('close', 15)}</button></div>`; })
        : html`<div class="sm-empty">No episodes in ${seasonName(n).toLowerCase()} yet. <button class="link" data-add="${n}">Add videos</button></div>`}
    </div>`; })}
    ${!E.id && !E.episodes.length ? html`<p class="dim sm-tip">${icon('info', 13)} Videos named like <code>Show.S01E03.mp4</code> number themselves. Anything else is numbered in name order — you can change it after.</p>` : ''}`.s;
  wireEditor(box);
}
function wireEditor(box) {
  box.oninput = e => {
    const f = e.target.dataset.f; if (f) { E[f] = e.target.value; changed(false); return; }
    const k = e.target.dataset.k; if (k === 'title') { E.episodes[+e.target.closest('[data-i]').dataset.i].title = e.target.value; changed(false); }
  };
  // numbers re-sort the list, so apply them when the field is left, not on every keystroke
  box.onchange = e => {
    const k = e.target.dataset.k; if (k !== 'season' && k !== 'episode') return;
    const ep = E.episodes[+e.target.closest('[data-i]').dataset.i];
    ep[k] = Math.max(k === 'season' ? 0 : 1, parseInt(e.target.value, 10) || (k === 'season' ? 0 : 1));
    changed(true);
  };
  box.onclick = async e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.create !== undefined) return create();
    if (b.dataset.add !== undefined) return addVideos(+b.dataset.add);
    if (b.dataset.newseason !== undefined) { const all = [...seasonsOf(E.episodes), ...E.extra].filter(n => n > 0); const n = (all.length ? Math.max(...all) : 0) + 1; E.extra.add(n); paintEditor(); return addVideos(n); }
    if (b.dataset.renumber !== undefined) { for (const n of seasonsOf(E.episodes)) E.episodes.filter(x => x.season === n).forEach((x, i) => { x.episode = i + 1; }); return changed(true); }
    if (b.dataset.del !== undefined) return remove();
    const row = b.closest('[data-i]'); if (!row) return;
    const i = +row.dataset.i, ep = E.episodes[i];
    if (b.dataset.rm !== undefined) { E.episodes.splice(i, 1); return changed(true); }
    if (b.dataset.mv) {   // swap places with the neighbour in the same season
      const same = E.episodes.filter(x => x.season === ep.season), j = same.indexOf(ep) + Number(b.dataset.mv), other = same[j];
      if (!other) return;
      if (other.episode === ep.episode) { ep.episode += Number(b.dataset.mv); } else { const t = ep.episode; ep.episode = other.episode; other.episode = t; }
      return changed(true);
    }
  };
}
const autosave = debounce(() => save(), 700);
function changed(repaint) {
  if (repaint) paintEditor();
  if (!E.id) return;
  E.status = 'Unsaved…'; const st = T && T.stage.querySelector('[data-st]'); if (st) st.textContent = E.status;
  autosave();
}
async function save() {
  if (!E || !E.id) return;
  const id = E.id;
  if (!E.name.trim()) { setStatus('Needs a name'); return; }
  setStatus('Saving…');
  try { await updateSeries(id, { name: E.name, description: E.description, episodes: E.episodes }); if (E && E.id === id) { setStatus('Saved'); paintSideList(); } }
  catch (e) { setStatus('Not saved — ' + e.message); }
}
function setStatus(s) { if (!E) return; E.status = s; const st = T && T.stage.querySelector('[data-st]'); if (st) st.textContent = s; }
async function create() {
  if (!E.name.trim()) { const n = T.stage.querySelector('.sm-name'); n.focus(); n.classList.add('shake'); setTimeout(() => n.classList.remove('shake'), 450); return toast('Give the series a name first', { ic: 'info' }); }
  try {
    const s = await createSeries({ name: E.name, description: E.description, episodes: E.episodes });
    toast(`${s.name} created`, { ic: 'video' });
    location.hash = '#/tools/series/' + s.id;
  } catch (e) { toast(e.message, { bad: true }); }
}
async function remove() {
  if (!(await confirm({ title: `Delete ${E.name || 'this series'}?`, text: 'The series goes away; the videos themselves stay in your Database.', ok: 'Delete series', danger: true, ic: 'trash' }))) return;
  try { await deleteSeries(E.id); toast('Series deleted', { ic: 'trash' }); location.hash = '#/tools/series' + (SER.list[0] ? '/' + SER.list[0].id : '/new'); }
  catch (e) { toast(e.message, { bad: true }); }
}
/* pick videos and number them into a season: S01E03-style names keep their own
   numbers, the rest follow on from the season's last episode, in name order */
async function addVideos(season) {
  const inIt = new Set(E.episodes.map(e => e.fileId));
  const near = new Set(E.episodes.map(e => (store.byId(e.fileId) || {}).parent ?? null));
  const ids = await pickFiles({ title: `Add videos to ${seasonName(season).toLowerCase()}`, multi: true, okLabel: 'Add',
    filter: f => f.type === 'video' && !inIt.has(f.id), rank: f => (near.has(f.parent ?? null) ? 1 : 0),
    empty: 'No more videos in your Database', hint: 'Choose several at once — they’re numbered in name order.' });
  if (!ids || !E) return;
  const vids = ids.map(store.byId).filter(Boolean).sort((a, b) => natural(a.name, b.name));
  // self-numbered ones first, so the rest can follow on after them without clashing
  const plain = [];
  for (const f of vids) {
    const se = parseSE(f.name);
    if (se.season != null && se.episode) E.episodes.push({ fileId: f.id, season: se.season, episode: se.episode, title: '' });
    else plain.push(f);
  }
  let next = Math.max(0, ...E.episodes.filter(e => e.season === season).map(e => e.episode)) + 1;
  for (const f of plain) E.episodes.push({ fileId: f.id, season, episode: next++, title: '' });
  E.extra.delete(season);
  changed(true);
  if (!E.id && !E.name.trim()) { const n = T.stage.querySelector('.sm-name'); if (n) n.focus(); }
}
