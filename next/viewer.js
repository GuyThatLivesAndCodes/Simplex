/* viewer.js — full-screen file viewer for the new UI. Images (zoom/pan/rotate), video,
   audio, PDF and editable text are native here; Markdown, HTML, CSV/TSV, JSON,
   subtitles, PDF and SVG have a Preview and a Raw mode. Other formats offer
   Download or the classic interface. The backdrop glows with the file's own colors. */
import { html, raw, el, icon, esc, fmtSize, fmtDur, ext, animate, SPRING, SMOOTH, lsGet, lsSet } from './lib.js';
import * as store from './store.js';
import { toast, menu, confirm, pushEsc, seg } from './ui.js';
import { md, wireCodeCopy, copyText } from './md.js';
import { parseSubs } from './captions.js';
import { details, renameItem } from './files.js';
import { openClassic } from './classic.js';
import { mountPlayer } from './player.js';
import { support, conversionsFor } from './formats.js';
import { chunkView } from './chunkview.js';
import { queueDownload, canConvert, convertDialog, queueConvert, canAiEdit, aiEditDialog } from './jobs.js';
import { ensureTos } from './upload.js';

const BIG_TEXT = 2 * 1024 * 1024;   // larger text files are read in parts, not loaded whole


let V = null;   // { root, list, idx, cleanup, popEsc, dirty }

/* opts: { autoNext, autoResume, labels: { fileId: "Show · S1 · E2" } } — a series opens its episodes this way */
export function openViewer(f, list, opts = {}) {
  if (V) closeViewer(true);
  const idx = Math.max(0, list.findIndex(x => x.id === f.id));
  const root = el(`<div class="vw" role="dialog" aria-modal="true"><div class="amb"></div><header class="vt"></header><div class="vs"></div></div>`);
  document.body.appendChild(root);
  V = { root, list: list.length ? list : [f], idx, cleanup: null, dirty: false, opts };
  V.popEsc = pushEsc(() => requestClose());
  try { history.pushState({ nxViewer: true }, ''); V.pushed = true; } catch (e) {}
  document.addEventListener('keydown', onKey);
  animate(root, [{ opacity: 0 }, { opacity: 1 }], { duration: 260, easing: SMOOTH });
  show();
}
window.addEventListener('popstate', () => { if (V) { V.pushed = false; closeViewer(); } });

async function requestClose() {
  if (V && V.dirty && !(await confirm({ title: 'Discard changes?', text: 'Your edits to this file haven’t been saved.', ok: 'Discard', danger: true, ic: 'pencil' }))) return;
  if (V && V.pushed) { history.back(); return; }   // popstate closes it
  closeViewer();
}
export function closeViewer(immediate) {
  if (!V) return;
  const v = V; V = null;
  setTimeout(() => window.dispatchEvent(new CustomEvent('nx:viewerclosed')), 0);   // e.g. the series page refreshes what's been watched
  v.popEsc(); if (v.cleanup) v.cleanup(); if (v.player) { v.player.destroy(); v.player = null; }
  document.removeEventListener('keydown', onKey);
  $media(v.root).forEach(m => { try { m.pause(); m.removeAttribute('src'); m.load(); } catch (e) {} });
  if (immediate) { v.root.remove(); return; }
  v.root.style.pointerEvents = 'none';
  animate(v.root, [{ opacity: 1 }, { opacity: 0 }], { duration: 200, fill: 'forwards', easing: SMOOTH }).then(() => v.root.remove());
}
const $media = r => [...r.querySelectorAll('video, audio')];
export const viewerOpen = () => !!V;

function step(d) {
  if (!V || V.list.length < 2) return;
  if (V.dirty) return toast('Save or discard your edits first', { bad: true });
  V.idx = (V.idx + d + V.list.length) % V.list.length;
  show(d);
}
function onKey(e) {
  if (!V) return;
  const typing = /^(INPUT|TEXTAREA)$/.test(document.activeElement && document.activeElement.tagName);
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); V.save && V.save(); return; }
  if (typing) return;
  if (e.key === 'PageDown' || (e.shiftKey && e.key === 'ArrowRight')) { e.preventDefault(); step(1); return; }
  if (e.key === 'PageUp' || (e.shiftKey && e.key === 'ArrowLeft')) { e.preventDefault(); step(-1); return; }
  if (V.player && V.player.key(e)) return;   // video/audio: arrows seek, space plays…
  if (V.rotate && e.key.toLowerCase() === 'r' && !e.ctrlKey && !e.metaKey) { V.rotate(); return; }
  if (e.key === 'ArrowRight') { e.preventDefault(); step(1); }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); }
}

function show(dir = 0) {
  const v = V, f = v.list[v.idx];
  if (v.cleanup) { v.cleanup(); v.cleanup = null; }
  if (v.player) { v.player.destroy(); v.player = null; }
  v.dirty = false; v.save = null; v.rotate = null;
  head(f);
  const stage = v.root.querySelector('.vs');
  stage.innerHTML = '';
  if (v.list.length > 1) {
    stage.appendChild(el(html`<button class="nav prev" aria-label="Previous">${icon('back', 20)}</button>`.s)).onclick = () => step(-1);
    stage.appendChild(el(html`<button class="nav next" aria-label="Next">${icon('chevron', 20)}</button>`.s)).onclick = () => step(1);
  }
  setAmbient(store.cheapThumb(f));
  stage.oncontextmenu = e => {   // right-click anywhere on the stage (but not inside text)
    if (e.target.closest('textarea, input, .cv-out')) return;
    e.preventDefault(); menu(viewerMenu(store.byId(f.id) || f), { x: e.clientX, y: e.clientY });
  };
  const content = body(f);
  stage.appendChild(content);
  animate(content, [{ opacity: 0, transform: `translateX(${dir * 40}px) scale(0.97)` }, { opacity: 1, transform: 'none' }], { duration: 420, easing: SPRING });
}

function head(f) {
  const v = V;
  const t = v.root.querySelector('.vt');
  t.innerHTML = html`<span class="vi tint t-${f.type}">${icon(f.type, 18)}</span>
    <div class="vn"><b>${(v.opts.labels && v.opts.labels[f.id]) || f.name}</b><small>${v.opts.labels && v.opts.labels[f.id] ? f.name + ' · ' : ''}${(ext(f.name) || f.type).toUpperCase()} · ${fmtSize(f.size)}${f.dur ? ' · ' + fmtDur(f.dur) : ''}${v.list.length > 1 ? ` · ${v.idx + 1} of ${v.list.length}` : ''}</small></div>
    <button class="ib${f.starred ? ' on' : ''}" data-v="star" aria-label="Star">${icon('star', 18)}</button>
    <button class="ib" data-v="dl" aria-label="Download">${icon('download', 18)}</button>
    <button class="ib" data-v="more" aria-label="More">${icon('more', 18)}</button>
    <button class="ib" data-v="close" aria-label="Close" style="background:var(--l2)">${icon('close', 18)}</button>`.s;
  t.onclick = async e => {
    const b = e.target.closest('[data-v]'); if (!b) return;
    const a = b.dataset.v, cur = store.byId(f.id) || f;
    if (a === 'close') requestClose();
    else if (a === 'dl') queueDownload(f.id);
    else if (a === 'star') { await store.setStar(f.id, !cur.starred); b.classList.toggle('on', !cur.starred); animate(b, [{ transform: 'scale(1.35)' }, { transform: 'none' }], { duration: 420, easing: SPRING }); }
    else if (a === 'more') menu(viewerMenu(f), b);
  };
}
/* the viewer's menu: the more button and right-click on the stage share it */
function viewerMenu(f) {
  const extras = V && V.player && V.player.extras ? V.player.extras() : [];
  return [
    ...extras, extras.length && '-',
    canAiEdit(f) && { label: 'AI Edit…', ic: 'spark', run: () => aiEditDialog(f.id) },
    canConvert(f) && { label: 'Convert…', ic: 'swap', run: () => convertDialog(f.id) },
    { label: 'Download', ic: 'download', run: () => queueDownload(f.id) },
    { label: 'Details', ic: 'info', run: () => details(f.id) },
    { label: 'Rename', ic: 'pencil', run: () => renameItem(f.id).then(() => { const n = store.byId(f.id); if (n && V) { V.list[V.idx] = n; head(n); } }) },
    { label: 'Open in classic', ic: 'swap', run: () => openClassic('/database/file/' + f.id) },
    '-',
    { label: 'Move to Trash', ic: 'trash', danger: true, run: async () => { await store.trash([f.id]); toast('Moved to Trash', { ic: 'trash', action: 'Undo', onAction: () => store.restore([f.id]) }); V.list.splice(V.idx, 1); if (!V.list.length) requestClose(); else { V.idx %= V.list.length; show(); } } },
  ].filter(Boolean);
}

function setAmbient(url) {
  const a = V.root.querySelector('.amb');
  if (url) { a.style.backgroundImage = `url("${url.replace(/"/g, '%22')}")`; a.classList.add('on'); }
  else a.classList.remove('on');
}

function body(f) {
  if (f.locked) return notHere(f, 'This file is locked', 'Unlocking protected files is still in the classic interface.', { classic: true });
  const sup = support(f);
  if (sup.how === 'image') return ext(f.name) === 'svg' && f.url ? withModes(f, 'svg', () => imageView(f), () => textView(f, { readOnly: true })) : imageView(f, sup.preview);
  if (sup.how === 'video' || sup.how === 'audio') {
    // no poster= here: it would make the server render one with ffmpeg right as the stream starts
    V.player = mountPlayer(f, { kind: sup.how, cover: store.cheapThumb(f), host: V.root, autoResume: !!V.opts.autoResume, upNext: upNext(), onFail: () => swap(notHere(f, 'Can’t play this file here', 'Your browser knows the format, but not how this particular file is encoded (its codec).', { convert: true })) });
    return V.player.el;
  }
  if (sup.how === 'pdf') return withModes(f, 'pdf', () => el(`<iframe class="pdfv" src="${esc(f.url)}" title="${esc(f.name)}"></iframe>`), () => chunked(f, 'text'));
  if (sup.how === 'text') return (f.size || 0) > BIG_TEXT ? chunked(f, 'text') : textView(f);   // raw files and database-backed docs alike
  if (f.type === 'model3d' || f.type === 'uasset') return notHere(f, 'No 3D viewer here yet', 'The 3D model and game-asset viewers are still in the classic interface.', { classic: true, convert: false });
  return notHere(f, 'Not compatible with this browser', sup.why, { convert: true, tryable: sup.tryable });
}
/* in a series, the next episode starts by itself when one ends */
function upNext() {
  const v = V; if (!v || !v.opts.autoNext || v.idx >= v.list.length - 1) return null;
  const n = v.list[v.idx + 1];
  return { label: (v.opts.labels && v.opts.labels[n.id]) || n.name, go: () => { if (V === v) step(1); } };
}
/* replace the current stage content (e.g. a player that turned out unplayable) */
function swap(node) {
  if (!V) return;
  if (V.player && !V.player.el.contains(node)) { V.player.destroy(); V.player = null; }
  const stage = V.root.querySelector('.vs'), cur = stage.querySelector(':scope > :not(.nav)');
  if (cur) cur.replaceWith(node); else stage.appendChild(node);
  animate(node, [{ opacity: 0, transform: 'scale(0.97)' }, { opacity: 1, transform: 'none' }], { duration: 380 });
}
function chunked(f, mode) { const n = chunkView(f, { mode }); V.cleanup = () => n.destroy(); return n; }

/* the "can't open this here" card: say why, then offer what CAN be done */
function notHere(f, title, why, { convert = true, classic = false, tryable = false } = {}) {
  const conv = convert && canConvert(f) ? conversionsFor(f) : [];
  const first = conv.length ? conv[0].targets[0] : null;   // mp4 for video, mp3 for audio, png for images
  const n = el(html`<div class="na wide"><div class="ei tint t-${f.type}">${icon(f.type, 32, 1.5)}<span class="na-x">${icon('info', 14, 2.2)}</span></div>
    <span class="chip">Incompatible file</span><b>${title}</b><p>${why}</p>
    <div class="acts">
      ${first ? html`<button class="b pri" data-a="conv">${icon('swap', 16)} Convert to ${first.toUpperCase()}</button>` : ''}
      ${f.locked ? '' : html`<button class="b" data-a="dl">${icon('download', 16)} Download</button>`}
      ${f.url && !f.locked ? html`<button class="b" data-a="anyway">${icon('eye', 16)} Open anyway</button>` : ''}
      ${classic ? html`<button class="b${first ? '' : ' pri'}" data-a="classic">${icon('swap', 16)} Open in classic</button>` : ''}
    </div>
    <div class="na-links">${conv.length ? html`<button class="link" data-a="more">Other formats…</button>` : ''}${tryable ? html`<button class="link" data-a="try">Try playing it anyway</button>` : ''}</div>
    <p class="na-note dim">${icon('info', 12)} “Open anyway” reads the raw file a small part at a time and asks before loading more, so even a huge file can’t freeze the page.</p></div>`.s);
  n.onclick = async e => {
    const b = e.target.closest('[data-a]'); if (!b) return;
    const a = b.dataset.a;
    if (a === 'conv') { if (await ensureTos()) queueConvert(f, conv[0].tool, first, 'save'); }
    else if (a === 'more') convertDialog(f.id);
    else if (a === 'dl') queueDownload(f.id);
    else if (a === 'classic') openClassic('/database/file/' + f.id);
    else if (a === 'anyway') swap(chunked(f));
    else if (a === 'try') {
      const p = mountPlayer(f, { kind: f.type, cover: store.cheapThumb(f), host: V.root, onFail: () => swap(notHere(f, 'That didn’t work', 'The browser couldn’t decode this file.', { convert: true })) });
      swap(p.el); V.player = p;
    }
  };
  return n;
}

/* image: wheel / pinch / double-click zoom, drag to pan */
function imageView(f, preview) {
  const wrap = el(html`<div class="imgwrap"><img src="${preview ? f.posterUrl : f.url}" alt="${f.name}" draggable="false"></div>`.s);
  const img = wrap.querySelector('img');
  let z = 1, x = 0, y = 0, rot = 0, drag = null;
  const zoomUi = el(html`<div class="zoom"><button class="ib sm" data-z="-">${icon('minus', 16)}</button><span>100%</span><button class="ib sm" data-z="+">${icon('plus', 16)}</button><button class="ib sm" data-z="fit" title="Fit">${icon('fit', 16)}</button><i class="zsep"></i><button class="ib sm" data-z="rot" title="Rotate (R)">${icon('rotate', 16)}</button><button class="ib sm" data-z="copy" title="Copy image">${icon('copy', 16)}</button></div>`.s);
  const apply = (smooth = true) => {
    img.style.transition = smooth ? '' : 'none';
    img.style.transform = `translate(${x}px, ${y}px) scale(${z}) rotate(${rot}deg)`;
    img.classList.toggle('zoomed', z > 1);
    zoomUi.querySelector('span').textContent = Math.round(z * 100) + '%';
  };
  const setZ = (nz, cx, cy) => {
    nz = Math.min(8, Math.max(1, nz));
    if (cx != null) { const r = img.getBoundingClientRect(); const ox = cx - (r.left + r.width / 2), oy = cy - (r.top + r.height / 2); x -= ox * (nz / z - 1); y -= oy * (nz / z - 1); }
    z = nz; if (z === 1) { x = 0; y = 0; } apply();
  };
  wrap.addEventListener('wheel', e => { e.preventDefault(); setZ(z * (e.deltaY < 0 ? 1.15 : 1 / 1.15), e.clientX, e.clientY); }, { passive: false });
  img.addEventListener('dblclick', e => setZ(z > 1 ? 1 : 2.5, e.clientX, e.clientY));
  const pts = new Map(); let pinch = null;
  wrap.addEventListener('pointerdown', e => {
    pts.set(e.pointerId, e); wrap.setPointerCapture(e.pointerId);
    if (pts.size === 2) { const [a, b] = [...pts.values()]; pinch = { d: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY), z }; drag = null; }
    else if (z > 1) drag = { sx: e.clientX - x, sy: e.clientY - y };
  });
  wrap.addEventListener('pointermove', e => {
    if (!pts.has(e.pointerId)) return; pts.set(e.pointerId, e);
    if (pinch && pts.size === 2) { const [a, b] = [...pts.values()]; setZ(pinch.z * Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) / pinch.d); }
    else if (drag) { x = e.clientX - drag.sx; y = e.clientY - drag.sy; apply(false); }
  });
  const up = e => { pts.delete(e.pointerId); if (pts.size < 2) pinch = null; if (!pts.size) drag = null; };
  wrap.addEventListener('pointerup', up); wrap.addEventListener('pointercancel', up);
  zoomUi.onclick = e => { const b = e.target.closest('[data-z]'); if (!b) return; const k = b.dataset.z; if (k === 'fit') setZ(1); else if (k === 'rot') rotate(); else if (k === 'copy') copyImage(); else setZ(z * (k === '+' ? 1.4 : 1 / 1.4)); };
  // a sideways photo turns a quarter at a time (just the view - the file is unchanged)
  const rotate = () => { rot += 90; apply(); };
  V.rotate = rotate;
  async function copyImage() {
    try {
      const c = document.createElement('canvas'), q = rot % 180 !== 0;
      c.width = q ? img.naturalHeight : img.naturalWidth; c.height = q ? img.naturalWidth : img.naturalHeight;
      const g = c.getContext('2d'); g.translate(c.width / 2, c.height / 2); g.rotate(rot * Math.PI / 180); g.drawImage(img, -img.naturalWidth / 2, -img.naturalHeight / 2);
      const blob = await new Promise(r => c.toBlob(r, 'image/png'));
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      toast('Image copied', { ic: 'copy' });
    } catch (e) { toast('Couldn’t copy this image', { bad: true }); }
  }
  const frag = el('<div style="display:contents"></div>');
  frag.append(wrap, zoomUi);
  img.onerror = () => frag.replaceWith(notHere(f, 'Couldn’t show this image', 'The browser can’t decode this image.', { convert: true }));
  return frag;
}

/* ---------- Preview / Raw ----------
   A file kind's last choice is remembered (nx.docmode.<kind>). Preview is the
   default for everything that has one. */
const modeOf = kind => lsGet('nx.docmode.' + kind) || 'preview';
const modeSeg = () => html`<span class="seg" data-mode><button data-v="preview">${icon('eye', 13)} Preview</button><button data-v="raw">${icon('code', 13)} Raw</button></span>`;

/* a file whose two modes are separate views (PDF, SVG): a pill above, the view below */
function withModes(f, kind, preview, rawView) {
  const box = el(html`<div class="dv-modes">${modeSeg()}<div class="dv-body"></div></div>`.s);
  const body = box.querySelector('.dv-body');
  const put = mode => {
    if (V && V.cleanup) { V.cleanup(); V.cleanup = null; }
    if (V) { V.save = null; V.dirty = false; }
    body.innerHTML = '';
    body.appendChild(mode === 'raw' ? rawView() : preview());
  };
  seg(box.querySelector('[data-mode]'), modeOf(kind), v => { lsSet('nx.docmode.' + kind, v); put(v); });
  put(modeOf(kind));
  return box;
}

/* which preview a text file gets, by extension */
const PREVIEW_KIND = { md: 'md', markdown: 'md', html: 'html', htm: 'html', csv: 'table', tsv: 'table', json: 'json', jsonl: 'json', ndjson: 'json', srt: 'subs', vtt: 'subs', ass: 'subs', ssa: 'subs' };

/* text: load, edit, save (Ctrl/⌘+S) — content goes back through PATCH /api/files/:id.
   Files with a preview open in it; Raw is the editor. The preview renders whatever
   is in the editor, so unsaved edits show in it too. */
function textView(f, { readOnly = false } = {}) {
  const kind = readOnly ? null : PREVIEW_KIND[ext(f.name)] || null;
  let mode = kind ? modeOf(kind) : 'raw', wrap = lsGet('nx.docwrap') !== '0';
  const n = el(html`<div class="doc${kind ? ' has-modes' : ''}"><div class="db">
      ${kind ? modeSeg() : ''}
      <span class="st">Loading…</span><span style="margin-left:auto" class="mono cnt"></span>
      <button class="ib sm" data-t="wrap" title="Wrap long lines">${icon('wrap', 15)}</button>
      <button class="ib sm" data-t="copy" title="Copy everything">${icon('copy', 15)}</button>
      ${readOnly ? '' : html`<button class="b sm pri" data-save disabled>${icon('check', 15)} Save</button>`}
    </div><textarea spellcheck="false" aria-label="File contents" disabled${readOnly ? raw(' readonly') : ''}></textarea><div class="dv-prev" tabindex="0" hidden></div></div>`.s);
  const ta = n.querySelector('textarea'), st = n.querySelector('.st'), cnt = n.querySelector('.cnt'), btn = n.querySelector('[data-save]'), prev = n.querySelector('.dv-prev');
  /* a textarea hands back \n even for a \r\n file, so compare in \n form and put the
     file's own line endings back on save - otherwise every Windows file opened as "Unsaved" */
  let orig = '', eol = '\n', loaded = false;
  const count = () => { cnt.textContent = `${ta.value.split('\n').length.toLocaleString()} lines · ${ta.value.length.toLocaleString()} chars`; };
  const mark = () => {
    if (readOnly) { st.textContent = 'Read-only'; count(); return; }
    const d = ta.value !== orig; if (V) V.dirty = d; st.textContent = d ? 'Unsaved' : 'Saved'; st.classList.toggle('dirty', d); btn.disabled = !d; count();
  };
  const save = async () => {
    if (readOnly || !V || !V.dirty) return;
    btn.disabled = true; st.textContent = 'Saving…';
    try { const val = ta.value; const row = await store.saveContent(f.id, eol === '\n' ? val : val.replace(/\n/g, eol)); orig = val; if (V) V.list[V.idx] = row; mark(); toast('Saved', { ic: 'check' }); }
    catch (e) { btn.disabled = false; st.textContent = 'Unsaved'; toast(e.code === 'LEGACY' ? 'This file uses the old key — re-encrypt it in Classic before editing' : e.message, { bad: true }); }
  };
  if (!readOnly) { V.save = save; btn.onclick = save; }
  const wrapBtn = n.querySelector('[data-t=wrap]');
  const setWrap = on => { wrap = on; ta.classList.toggle('nowrap', !on); wrapBtn.classList.toggle('on', on); };
  setWrap(wrap);
  wrapBtn.onclick = () => { setWrap(!wrap); lsSet('nx.docwrap', wrap ? '1' : '0'); };
  n.querySelector('[data-t=copy]').onclick = () => copyText(ta.value).then(() => toast('Copied', { ic: 'copy' }), () => toast('Couldn’t copy', { bad: true }));
  const show = m => {
    mode = m;
    const p = !!kind && m === 'preview';
    n.classList.toggle('previewing', p);
    ta.hidden = p; prev.hidden = !p; wrapBtn.hidden = p;
    if (p && loaded) { prev.innerHTML = ''; prev.appendChild(renderPreview(kind, ta.value, f)); }
    else if (!p && loaded) ta.focus({ preventScroll: true });
  };
  if (kind) seg(n.querySelector('[data-mode]'), mode, v => { lsSet('nx.docmode.' + kind, v); show(v); });
  ta.addEventListener('input', mark);
  ta.addEventListener('keydown', e => { if (e.key === 'Tab' && !readOnly) { e.preventDefault(); const s = ta.selectionStart; ta.setRangeText('  ', s, ta.selectionEnd, 'end'); mark(); } });
  show(mode);
  store.fetchText(f).then(t => {
    eol = /\r\n/.test(t) ? '\r\n' : '\n'; orig = t.replace(/\r\n?/g, '\n'); ta.value = orig; ta.disabled = false; loaded = true;
    mark(); if (!readOnly) st.textContent = 'Saved';
    show(mode);
    if (mode === 'raw' && !kind) { ta.focus(); ta.setSelectionRange(0, 0); }
  }).catch(e => { st.textContent = 'Couldn’t load'; toast(e.message, { bad: true }); });
  return n;
}

/* ---------- previews ---------- */
function renderPreview(kind, text, f) {
  try {
    if (kind === 'md') { const d = el(`<div class="ai-md dv-md">${md(text)}</div>`); wireCodeCopy(d, () => toast('Copied', { ic: 'copy' })); return d; }
    if (kind === 'html') {
      // sandboxed: no scripts and no reach into this page; the page's own rules still apply (so no outside images)
      const box = el(html`<div class="dv-htmlbox"><iframe class="dv-html" sandbox="" title="${f.name}"></iframe><p class="dv-note">${icon('info', 12)} Scripts don’t run in the preview, and pictures from other sites aren’t loaded.</p></div>`.s);
      box.querySelector('iframe').srcdoc = text;
      return box;
    }
    if (kind === 'table') return tablePreview(text, ext(f.name) === 'tsv' ? '\t' : null);
    if (kind === 'json') return jsonPreview(text);
    if (kind === 'subs') return subsPreview(text);
  } catch (e) { return el(html`<div class="dv-err">${icon('info', 15)} Couldn’t show a preview: ${e.message || 'error'}</div>`.s); }
  return el('<div></div>');
}

const ROWS_MAX = 2000;
function parseDelimited(text, sep) {
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
    else if (c === '"' && cell === '') q = true;
    else if (c === sep) { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}
function tablePreview(text, sep) {
  if (!sep) {   // CSV from European spreadsheets uses semicolons
    const nl = text.indexOf('\n'), first = nl < 0 ? text : text.slice(0, nl);
    sep = first.split(';').length > first.split(',').length ? ';' : ',';
  }
  const rows = parseDelimited(text, sep);
  if (!rows.length) return el('<div class="dv-err">This file is empty.</div>');
  const head = rows[0], body = rows.slice(1, ROWS_MAX + 1);
  const cols = Math.min(200, Math.max(...rows.slice(0, ROWS_MAX + 1).map(r => r.length)));
  const num = s => /^\s*-?[\d.,]+%?\s*$/.test(s);
  const cell = (s, tag) => `<${tag}${tag === 'td' && num(s) ? ' class="n"' : ''}>${esc(s)}</${tag}>`;
  const box = el(`<div class="dv-tablebox"><div class="dv-table"><table><thead><tr><th class="rn">#</th>${Array.from({ length: cols }, (_, i) => cell(head[i] ?? '', 'th')).join('')}</tr></thead><tbody>${body.map((r, i) => `<tr><td class="rn">${i + 1}</td>${Array.from({ length: cols }, (_, j) => cell(r[j] ?? '', 'td')).join('')}</tr>`).join('')}</tbody></table></div></div>`);
  box.appendChild(el(html`<p class="dv-note">${(rows.length - 1).toLocaleString()} rows · ${cols} columns${rows.length - 1 > ROWS_MAX ? ` · showing the first ${ROWS_MAX.toLocaleString()} (Raw has the rest)` : ''}</p>`.s));
  return box;
}

function jsonPreview(text) {
  let v;
  try { v = JSON.parse(text); }
  catch (e) {
    // JSON Lines / NDJSON: one value per line
    try { v = text.split('\n').filter(l => l.trim()).map(l => JSON.parse(l)); }
    catch (e2) { return el(html`<div class="dv-err">${icon('info', 15)} This isn’t valid JSON: ${e.message}. Switch to Raw to fix it.</div>`.s); }
  }
  let budget = 6000;
  const prim = x => x === null ? '<i class="j-null">null</i>' : typeof x === 'string' ? `<i class="j-str">"${esc(x.length > 2000 ? x.slice(0, 2000) + '…' : x)}"</i>` : typeof x === 'number' ? `<i class="j-num">${x}</i>` : `<i class="j-bool">${x}</i>`;
  const node = (x, k, depth) => {
    if (--budget < 0) return budget === -1 ? '<div class="j-more">… more in Raw</div>' : '';
    const key = k == null ? '' : `<b class="j-key">${esc(String(k))}</b>: `;
    if (x === null || typeof x !== 'object') return `<div class="j-row">${key}${prim(x)}</div>`;
    const arr = Array.isArray(x), entries = arr ? x.map((v2, i) => [i, v2]) : Object.entries(x);
    if (!entries.length) return `<div class="j-row">${key}<i class="j-sum">${arr ? '[ ]' : '{ }'}</i></div>`;
    return `<details${depth < 2 ? ' open' : ''}><summary>${key}<i class="j-sum">${arr ? `[${entries.length}]` : `{${entries.length}}`}</i></summary><div class="j-kids">${entries.map(([k2, v2]) => node(v2, k2, depth + 1)).join('')}</div></details>`;
  };
  return el(`<div class="dv-json">${node(v, null, 0)}</div>`);
}

function subsPreview(text) {
  const cues = parseSubs(text);
  if (!cues.length) return el('<div class="dv-err">No timed lines found in this file.</div>');
  const t = s => fmtDur(s) + '.' + Math.floor((s % 1) * 10);
  return el(`<div class="dv-subs"><p class="dv-note">${cues.length.toLocaleString()} lines · ${fmtDur(cues[cues.length - 1].end)} long${cues.length > 5000 ? ' · showing the first 5,000' : ''}</p>${cues.slice(0, 5000).map(c => `<div class="sl"><span class="mono">${t(c.start)} → ${t(c.end)}</span><div>${c.html}</div></div>`).join('')}</div>`);
}
